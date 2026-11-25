// このファイルはオンライン通信とゲームの進行管理を担当します。
// キャラクターの移動や攻撃ルールはgame.jsにあり、callbacks経由で呼び出します。
//
// 対戦中の流れ:
// 1. advance()が時間を60分の1秒ずつに分け、simulateFrame()を呼ぶ
// 2. 自分の入力をすぐ使い、未着の相手入力は予測してゲームを進める
// 3. 入力を相手へ送り、相手から届いた入力と予測を比べる
// 4. 予測が違えば過去の状態へ戻り、正しい入力で現在まで再計算する

// 1フレームの長さ。1000ミリ秒 ÷ 60フレーム = 約16.7ミリ秒。
const FIXED_STEP_MS = 1000 / 60;
// 巻き戻しに使う履歴の上限。180フレームは約3秒分。
const MAX_ROLLBACK_FRAMES = 180;
// 画面が止まった後に、1回の描画で追いつくシミュレーション回数の上限。
const MAX_STEPS_PER_RENDER = 5;
// 通信相手と同じルールかを確かめる番号。通信形式を変えたら更新する。
const PROTOCOL_VERSION = 2;
// 通信で使うキー名を統一する。配列の順番ではなく名前で照合する。
const INPUT_ACTIONS = ['left', 'right', 'jump', 'down', 'weak', 'medium', 'strong', 'special'];

// 入力オブジェクトにキーの抜けがあっても、全キーをtrue/falseにそろえる。
function normalizeInput(input) {
  const normalized = {};
  for (const action of INPUT_ACTIONS) {
    normalized[action] = Boolean(input?.[action]);
  }
  return normalized;
}

// 相手の入力がまだ届いていないフレーム用の「何も押していない」入力。
function neutralInput() {
  return normalizeInput({});
}

// 2つの入力が同じかを、移動・攻撃など全キーについて調べる。
function inputsMatch(first, second) {
  return INPUT_ACTIONS.every((action) => Boolean(first?.[action]) === Boolean(second?.[action]));
}

// オンライン接続とロールバックをまとめたクラス。
// callbacksはゲーム本体(game.js)の関数を受け取り、両ファイルをつなぎます。
export class RollbackNetwork {
  constructor(callbacks) {
    this.callbacks = callbacks;
    // PeerJS本体と、Peer同士でデータを送受信する通信路。
    this.peer = null;
    this.channel = null;
    // local: ローカル2人、host: 1P側、guest: 2P側。
    this.role = 'local';
    this.pingAt = 0;
    this.handshakeTimeout = null;
    // シミュレーションの時間と、何フレーム目かを記録する。
    this.simulationAccumulator = 0;
    this.simulationFrame = 0;
    // オンライン試合が始まっているか、同期のため停止しているか。
    this.onlineStarted = false;
    this.syncPaused = false;
    // syncEpochは古い試合の入力を無視するための世代番号。
    this.syncEpoch = 0;
    this.pendingResyncToken = null;
    this.resyncTokenSequence = 0;
    // 過去へ戻るための履歴。キーはフレーム番号。
    this.frameInputs = new Map();
    this.receivedRemoteInputs = new Map();
    this.frameStates = new Map();
    this.bindUi();
    this.callbacks.resetRound();
    this.clearRollbackHistory();
  }

  // ローカルではなく、オンライン試合が実際に開始済みならtrue。
  get isOnline() {
    return this.role !== 'local' && this.onlineStarted;
  }

  // HTMLのボタンを、このクラスの操作に結びつける。
  bindUi() {
    document.getElementById('createRoomBtn').addEventListener('click', () => {
      this.createRoom();
    });
    document.getElementById('copyRoomBtn').addEventListener('click', () => {
      this.copyRoomCode();
    });
    document.getElementById('joinRoomBtn').addEventListener('click', () => {
      this.joinRoom();
    });
    document.getElementById('resetConnectionBtn').addEventListener('click', () => {
      this.resetConnection();
    });
    document.getElementById('restart').addEventListener('click', () => {
      this.restart();
    });
  }

  // 対戦の役割を切り替え、新しい試合用に状態と履歴を初期化する。
  setRole(role) {
    this.role = role;
    this.onlineStarted = role === 'local';
    this.syncPaused = false;
    this.syncEpoch = 0;
    this.pendingResyncToken = null;
    this.simulationFrame = 0;
    this.simulationAccumulator = 0;
    this.callbacks.roleChanged(role);
    this.callbacks.resetRound();
    this.clearRollbackHistory();
  }

  // 描画ごとの経過時間をため、16.7msたまるたびにゲームを1フレーム進める。
  // stepsは今回の呼び出しで進めた回数。画面が止まった後の過剰処理を防ぐ。
  advance(deltaTime) {
    this.simulationAccumulator += deltaTime;
    let steps = 0;
    while (
      this.simulationAccumulator >= FIXED_STEP_MS &&
      steps < MAX_STEPS_PER_RENDER
    ) {
      this.simulateFrame();
      this.simulationAccumulator -= FIXED_STEP_MS;
      steps += 1;
    }
  }

  // 約700msごとにpingを送り、受信後のpongで往復時間(RTT)を表示する。
  tick(now) {
    if (this.channel?.open && now - this.pingAt > 700) {
      this.send({ type: 'ping', t: now });
      this.pingAt = now;
    }
  }

  // ゲームを1フレーム進める。オンラインでは予測入力を使い、同じ入力を相手へ送る。
  simulateFrame() {
    if (this.role === 'local') {
      // ローカル対戦は両プレイヤーのキーボード入力をそのまま使う。
      this.callbacks.simulateFrame([
        this.callbacks.inputFor(0),
        this.callbacks.inputFor(1),
      ]);
      this.simulationFrame += 1;
      return;
    }
    if (!this.onlineStarted || this.syncPaused || !this.channel?.open) {
      return;
    }

    const frame = this.simulationFrame;
    const localPlayer = this.role === 'host' ? 0 : 1;
    const remotePlayer = 1 - localPlayer;
    const inputs = [];
    // 自分のキーはすぐ反映。相手のキーは届いていれば実入力、未着なら予測入力。
    inputs[localPlayer] = normalizeInput(this.callbacks.inputFor(localPlayer));
    inputs[remotePlayer] = this.remoteInputForFrame(frame, remotePlayer);
    // このフレームの開始時点の状態と、実際に使った入力をあとで戻れるよう保存。
    this.frameInputs.set(frame, inputs.map(normalizeInput));
    this.frameStates.set(frame, this.callbacks.captureState());
    this.callbacks.simulateFrame(inputs);
    this.simulationFrame = frame + 1;
    this.pruneRollbackHistory();
    // ゲーム全体の状態ではなく、自分のフレーム入力を相手へ送る。
    this.send({
      type: 'input',
      protocol: PROTOCOL_VERSION,
      epoch: this.syncEpoch,
      frame,
      input: inputs[localPlayer],
    });
  }

  // 指定フレームの相手入力を返す。まだ受信していなければ直前の入力を使う。
  remoteInputForFrame(frame, remotePlayer) {
    const received = this.receivedRemoteInputs.get(frame);
    if (received) {
      return received;
    }
    return this.frameInputs.get(frame - 1)?.[remotePlayer] || neutralInput();
  }

  // 試合開始や再同期の直後に、古い履歴を消して現在の状態を起点として保存する。
  clearRollbackHistory() {
    this.frameInputs.clear();
    this.receivedRemoteInputs.clear();
    this.frameStates.clear();
    this.frameStates.set(this.simulationFrame, this.callbacks.captureState());
  }

  // 古い履歴を削除して、メモリ使用量が増え続けないようにする。
  pruneRollbackHistory() {
    const oldestFrame = this.simulationFrame - MAX_ROLLBACK_FRAMES;
    for (const frame of this.frameInputs.keys()) {
      if (frame < oldestFrame - 1) {
        this.frameInputs.delete(frame);
      }
    }
    for (const frame of this.receivedRemoteInputs.keys()) {
      if (frame < oldestFrame) {
        this.receivedRemoteInputs.delete(frame);
      }
    }
    for (const frame of this.frameStates.keys()) {
      if (frame < oldestFrame) {
        this.frameStates.delete(frame);
      }
    }
  }

  // 予測が外れたフレームまで戻り、保存済みの自分の入力と正しい相手入力で再計算する。
  rollbackFrom(frame) {
    const startState = this.frameStates.get(frame);
    if (!startState) {
      this.pauseForResync(frame);
      return;
    }

    const endFrame = this.simulationFrame;
    for (let replayFrame = frame; replayFrame < endFrame; replayFrame += 1) {
      if (!this.frameInputs.has(replayFrame)) {
        this.pauseForResync(replayFrame);
        return;
      }
    }

    const localPlayer = this.role === 'host' ? 0 : 1;
    const remotePlayer = 1 - localPlayer;
    this.callbacks.restoreState(startState);
    for (let replayFrame = frame; replayFrame < endFrame; replayFrame += 1) {
      const savedInputs = this.frameInputs.get(replayFrame);
      const inputs = [];
      inputs[localPlayer] = savedInputs[localPlayer];
      inputs[remotePlayer] = this.remoteInputForFrame(replayFrame, remotePlayer);
      this.frameStates.set(replayFrame, this.callbacks.captureState());
      this.frameInputs.set(replayFrame, inputs.map(normalizeInput));
      this.callbacks.simulateFrame(inputs);
      this.simulationFrame = replayFrame + 1;
    }
    this.pruneRollbackHistory();
  }

  // 相手から届いた入力を検査し、過去に使った予測と違えば巻き戻しを始める。
  receiveRemoteInput(message) {
    if (
      message.protocol !== PROTOCOL_VERSION ||
      message.epoch !== this.syncEpoch ||
      !Number.isInteger(message.frame) ||
      message.frame < 0 ||
      !message.input ||
      typeof message.input !== 'object' ||
      Array.isArray(message.input)
    ) {
      return;
    }
    const frame = message.frame;
    if (frame > this.simulationFrame + MAX_ROLLBACK_FRAMES) {
      this.pauseForResync(frame);
      return;
    }
    const input = normalizeInput(message.input);
    const existing = this.receivedRemoteInputs.get(frame);
    // 同じ入力を再度受信しても再計算は不要。
    if (existing && inputsMatch(existing, input)) {
      return;
    }
    this.receivedRemoteInputs.set(frame, input);
    if (frame >= this.simulationFrame) {
      return;
    }

    const remotePlayer = this.role === 'host' ? 1 : 0;
    const usedInput = this.frameInputs.get(frame)?.[remotePlayer];
    if (!usedInput) {
      this.pauseForResync(frame);
    } else if (!inputsMatch(usedInput, input)) {
      this.rollbackFrom(frame);
    }
  }

  // 必要な巻き戻し履歴がないほど遅れた場合、試合を止めて両者の状態を合わせる。
  pauseForResync(frame) {
    if (this.syncPaused || !this.channel?.open) {
      return;
    }
    this.syncPaused = true;
    if (this.role === 'host') {
      const token = ++this.resyncTokenSequence;
      this.pendingResyncToken = token;
      this.syncEpoch += 1;
      this.send({
        type: 'resync-state',
        protocol: PROTOCOL_VERSION,
        token,
        epoch: this.syncEpoch,
        frame: this.simulationFrame,
        state: this.callbacks.captureState(),
      });
    } else {
      const token = ++this.resyncTokenSequence;
      this.pendingResyncToken = token;
      this.send({
        type: 'resync-request',
        protocol: PROTOCOL_VERSION,
        token,
        epoch: this.syncEpoch,
        frame,
      });
    }
    this.setConnectionStatus('通信遅延のため同期中です。ゲーム進行を一時停止しています。');
  }

  // ホストから届いた状態でゲームを復元し、応答を返して同期完了を知らせる。
  acceptResyncState(message) {
    if (
      message.protocol !== PROTOCOL_VERSION ||
      !Number.isInteger(message.token) ||
      !Number.isInteger(message.epoch) ||
      !Number.isInteger(message.frame) ||
      message.frame < 0 ||
      !this.callbacks.isValidState(message.state)
    ) {
      this.setConnectionStatus('受信した同期データが不正です。接続をやり直してください。');
      return;
    }
    if (this.role === 'guest' && this.pendingResyncToken !== null &&
      this.pendingResyncToken !== message.token) {
      return;
    }
    this.syncPaused = true;
    this.syncEpoch = message.epoch;
    this.simulationFrame = message.frame;
    this.simulationAccumulator = 0;
    this.callbacks.restoreState(message.state);
    this.clearRollbackHistory();
    this.pendingResyncToken = message.token;
    this.send({
      type: 'resync-ack',
      protocol: PROTOCOL_VERSION,
      token: message.token,
      epoch: this.syncEpoch,
    });
    if (this.role === 'guest') {
      this.syncPaused = false;
      this.pendingResyncToken = null;
      this.setConnectionStatus('オンライン対戦中（同期を再開しました）');
    }
  }

  // ホストが送った新ラウンドの開始状態を受け取り、ゲストの試合を開始する。
  beginOnlineRound(message) {
    if (
      message.protocol !== PROTOCOL_VERSION ||
      !Number.isInteger(message.epoch) ||
      !Number.isInteger(message.frame) ||
      message.frame < 0 ||
      !this.callbacks.isValidState(message.state)
    ) {
      this.setConnectionStatus('通信相手のゲームバージョンが異なります。両方を再読み込みしてください。');
      return;
    }
    clearTimeout(this.handshakeTimeout);
    this.handshakeTimeout = null;
    this.syncEpoch = message.epoch;
    this.simulationFrame = message.frame;
    this.simulationAccumulator = 0;
    this.callbacks.restoreState(message.state);
    this.onlineStarted = true;
    this.syncPaused = false;
    this.pendingResyncToken = null;
    this.clearRollbackHistory();
    this.callbacks.resetClock();
    this.setConnectionStatus('オンライン対戦中（ゲスト）');
  }

  // ホストが新ラウンドを作り、開始フレームと初期状態をゲストへ知らせる。
  startOnlineRound() {
    this.callbacks.resetRound();
    this.simulationFrame = 0;
    this.simulationAccumulator = 0;
    this.syncPaused = false;
    this.pendingResyncToken = null;
    this.clearRollbackHistory();
    this.syncEpoch += 1;
    this.onlineStarted = true;
    this.callbacks.resetClock();
    this.send({
      type: 'round-start',
      protocol: PROTOCOL_VERSION,
      epoch: this.syncEpoch,
      frame: this.simulationFrame,
      state: this.callbacks.captureState(),
    });
    this.setConnectionStatus(`オンライン対戦中（${this.role === 'host' ? 'ホスト' : 'ゲスト'}）`);
  }

  // 接続中のPeerJS DataConnectionへデータを送る。
  send(message) {
    if (!this.channel?.open) {
      return;
    }
    try {
      this.channel.send(message);
    } catch (error) {
      this.setConnectionStatus(`通信エラー: ${error.message}`);
    }
  }

  // 接続状態の表示だけをgame.jsへ依頼する。
  setConnectionStatus(message) {
    this.callbacks.setConnectionStatus(message);
  }

  // DataConnectionとPeerJS Peerを閉じ、接続に関するタイマーも解除する。
  closePeer() {
    const oldPeer = this.peer;
    const oldChannel = this.channel;
    this.peer = null;
    this.channel = null;
    clearTimeout(this.handshakeTimeout);
    this.handshakeTimeout = null;
    this.onlineStarted = false;
    this.syncPaused = false;
    oldChannel?.close();
    oldPeer?.destroy();
  }

  // 指定IDまたは自動生成IDでPeerJSの接続口を作る。
  createPeer(id = '') {
    if (!window.Peer) {
      throw new Error('PeerJSを読み込めません。インターネット接続を確認してページを再読み込みしてください。');
    }
    const currentPeer = id ? new Peer(id) : new Peer();
    this.peer = currentPeer;
    currentPeer.on('error', (error) => {
      if (this.peer !== currentPeer) {
        return;
      }
      const messages = {
        'peer-unavailable': '部屋が見つかりません。コードを確認してください。',
        network: '接続サービスに接続できません。',
        'server-error': '接続サービスでエラーが発生しました。',
        'unavailable-id': 'この部屋コードはすでに使われています。別のコードを入力してください。',
      };
      this.setConnectionStatus(messages[error.type] || `接続エラー: ${error.message}`);
    });
    return currentPeer;
  }

  // PeerJS DataConnectionの接続・切断・データ受信イベントを登録する。
  setupChannel(connection) {
    if (this.channel && this.channel !== connection) {
      connection.close();
      return;
    }
    this.channel = connection;
    connection.on('open', () => {
      if (this.channel !== connection) {
        return;
      }
      this.setConnectionStatus('ゲームのバージョンを確認しています…');
      this.handshakeTimeout = setTimeout(() => {
        if (this.channel === connection && !this.onlineStarted) {
          this.setConnectionStatus('相手と通信バージョンを確認できません。両方のページを最新版にしてください。');
        }
      }, 5000);
      // 接続後に通信ルールの番号を交換し、対応するバージョン同士か確かめる。
      this.send({ type: 'hello', protocol: PROTOCOL_VERSION });
    });
    connection.on('close', () => {
      if (this.channel === connection) {
        this.channel = null;
        clearTimeout(this.handshakeTimeout);
        this.handshakeTimeout = null;
        this.onlineStarted = false;
        this.syncPaused = false;
        this.setConnectionStatus('通信が切断されました');
      }
    });
    connection.on('error', (error) => {
      if (this.channel === connection) {
        this.setConnectionStatus(`通信エラー: ${error.message}`);
      }
    });
    connection.on('data', (message) => {
      this.handleMessage(message);
    });
  }

  // 受信メッセージのtypeを見て、入力、開始、再同期、再戦などの処理に振り分ける。
  handleMessage(message) {
    if (!message || typeof message !== 'object') {
      return;
    }
    if (message.type === 'hello') {
      if (message.protocol !== PROTOCOL_VERSION) {
        this.setConnectionStatus('通信相手のゲームバージョンが異なります。両方を再読み込みしてください。');
        return;
      }
      clearTimeout(this.handshakeTimeout);
      this.handshakeTimeout = null;
      if (this.role === 'host' && !this.onlineStarted) {
        this.startOnlineRound();
      } else if (this.role === 'guest' && !this.onlineStarted) {
        this.setConnectionStatus('通信バージョンを確認しました。ホストの開始を待っています…');
      }
    } else if (message.type === 'round-start' && this.role === 'guest') {
      this.beginOnlineRound(message);
    } else if (message.type === 'input') {
      this.receiveRemoteInput(message);
    } else if (message.type === 'resync-request' && this.role === 'host') {
      this.handleResyncRequest(message);
    } else if (message.type === 'resync-state' && this.role === 'guest') {
      this.acceptResyncState(message);
    } else if (message.type === 'resync-ack') {
      this.handleResyncAck(message);
    } else if (message.type === 'rematch' && this.role === 'host') {
      if (
        message.protocol === PROTOCOL_VERSION &&
        message.epoch === this.syncEpoch
      ) {
        this.startOnlineRound();
      }
    } else if (message.type === 'ping') {
      this.send({ type: 'pong', t: message.t });
    } else if (message.type === 'pong') {
      const roundTripTime = Math.round(performance.now() - message.t);
      if (!this.syncPaused && this.onlineStarted) {
        this.setConnectionStatus(`オンライン対戦中（往復 ${roundTripTime} ms）`);
      }
    }
  }

  // ゲストから同期要求が来たら、ホストの現在状態を送り返す。
  handleResyncRequest(message) {
    if (
      message.protocol !== PROTOCOL_VERSION ||
      message.epoch !== this.syncEpoch ||
      !Number.isInteger(message.token)
    ) {
      return;
    }
    this.syncPaused = true;
    this.pendingResyncToken = message.token;
    this.syncEpoch += 1;
    this.send({
      type: 'resync-state',
      protocol: PROTOCOL_VERSION,
      token: message.token,
      epoch: this.syncEpoch,
      frame: this.simulationFrame,
      state: this.callbacks.captureState(),
    });
    this.clearRollbackHistory();
    this.setConnectionStatus('通信遅延のため同期中です。ゲーム進行を一時停止しています。');
  }

  // ゲストの同期完了通知を確認し、ホスト側の試合を再開する。
  handleResyncAck(message) {
    if (
      this.role !== 'host' ||
      !this.syncPaused ||
      message.protocol !== PROTOCOL_VERSION ||
      message.token !== this.pendingResyncToken ||
      message.epoch !== this.syncEpoch
    ) {
      return;
    }
    this.pendingResyncToken = null;
    this.syncPaused = false;
    this.clearRollbackHistory();
    this.setConnectionStatus('オンライン対戦中（同期を再開しました）');
  }

  // 新しいPeerを作り、部屋コードを表示してゲスト接続を待ち受ける。
  createRoom() {
    const requestedCode = document.getElementById('createRoomCodeInput').value.trim();
    if (requestedCode && !/^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$/.test(requestedCode)) {
      this.setConnectionStatus('部屋コードは英数字で始まり、英数字・ハイフン・アンダースコアのみ使用できます。');
      return;
    }

    this.closePeer();
    this.setRole('host');
    const roomCodeInput = document.getElementById('roomCode');
    const copyButton = document.getElementById('copyRoomBtn');
    roomCodeInput.value = '';
    copyButton.disabled = true;
    this.setConnectionStatus('部屋を作成しています…');
    try {
      const hostPeer = this.createPeer(requestedCode);
      hostPeer.on('open', (id) => {
        if (this.peer === hostPeer) {
          roomCodeInput.value = id;
          copyButton.disabled = false;
          this.setConnectionStatus('部屋を作成しました。コードを相手に共有してください。');
        }
      });
      hostPeer.on('connection', (connection) => {
        if (this.channel) {
          connection.close();
          return;
        }
        this.setConnectionStatus('参加者の接続を待っています…');
        this.setupChannel(connection);
      });
    } catch (error) {
      this.setConnectionStatus(error.message);
    }
  }

  // 部屋コードをクリップボードへコピーする。失敗時は従来のコピー方法も試す。
  async copyRoomCode() {
    const roomCodeInput = document.getElementById('roomCode');
    if (!roomCodeInput.value) {
      return;
    }
    try {
      await navigator.clipboard.writeText(roomCodeInput.value);
      this.setConnectionStatus('部屋コードをコピーしました。');
    } catch (error) {
      roomCodeInput.select();
      const copied = document.execCommand('copy');
      this.setConnectionStatus(
        copied ? '部屋コードをコピーしました。' : `コピーできませんでした: ${error.message}`,
      );
    }
  }

  // 入力された部屋コードへ接続し、成功後に通信イベントを登録する。
  joinRoom() {
    const code = document.getElementById('joinCodeInput').value.trim();
    if (!code) {
      this.setConnectionStatus('参加する部屋コードを入力してください。');
      return;
    }
    this.closePeer();
    this.setRole('guest');
    this.setConnectionStatus('部屋に接続しています…');
    try {
      const guestPeer = this.createPeer();
      guestPeer.on('open', () => {
        if (this.peer === guestPeer) {
          this.setupChannel(guestPeer.connect(code, {
            reliable: true,
            serialization: 'json',
          }));
        }
      });
    } catch (error) {
      this.setConnectionStatus(error.message);
    }
  }

  // オンライン接続を終了してローカル2人対戦へ戻す。
  resetConnection() {
    this.closePeer();
    this.setRole('local');
    document.getElementById('roomCode').value = '';
    document.getElementById('joinCodeInput').value = '';
    document.getElementById('copyRoomBtn').disabled = true;
    this.setConnectionStatus('ローカル2人プレイ');
  }

  // 再戦ボタンの処理。ゲストは要求を送り、ホストは新しいラウンドを開始する。
  restart() {
    if (this.role === 'guest') {
      if (!this.channel?.open) {
        this.setConnectionStatus('通信が接続されていません');
        return;
      }
      this.send({ type: 'rematch', protocol: PROTOCOL_VERSION, epoch: this.syncEpoch });
      this.setConnectionStatus('ホストに再戦をリクエストしました');
      return;
    }
    if (this.role === 'host') {
      if (!this.channel?.open) {
        this.setConnectionStatus('通信が接続されていません');
        return;
      }
      this.startOnlineRound();
    } else {
      this.callbacks.resetRound();
      this.simulationFrame = 0;
      this.simulationAccumulator = 0;
      this.clearRollbackHistory();
    }
  }
}
