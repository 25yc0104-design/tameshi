'use strict';
// 画面とゲーム全体の状態
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const keys = new Set();
const hitEffects = [];
let peer = null;
let channel = null;
let role = 'local';
let gameOver = false;
let remaining = 99;
let lastSent = 0;
let lastState = 0;
let pingAt = 0;
let history = [];
let lastFrame = performance.now();
let audioCtx = null;
let screenShake = 0;
// ファイター1人分の初期状態
const fresh = () => ({
  x: 250,
  y: 335,
  vy: 0,
  onGround: true,
  jumpDir: 0,
  hp: 100,
  facing: 1,
  guard: false,
  attack: 0,
  attackKind: 0,
  attackId: 0,
  hitId: 0,
  stun: 0,
});
let fighters = [fresh(), { ...fresh(), x: 710, facing: -1 }];
let remoteInput = [{}, {}];
let prior = [{}, {}];
// ローカル2Pとオンライン共通のキー割り当て
const keymap = [
  {
    jump: 'KeyW',
    left: 'KeyA',
    right: 'KeyD',
    weakPunch: 'KeyU',
    mediumPunch: 'KeyI',
    strongPunch: 'KeyO',
    weakKick: 'KeyJ',
    mediumKick: 'KeyK',
    strongKick: 'KeyL',
    guard: 'KeyT',
    throw: 'KeyR',
  },
  {
    jump: 'ArrowUp',
    left: 'ArrowLeft',
    right: 'ArrowRight',
    weakPunch: 'Digit1',
    mediumPunch: 'Digit2',
    strongPunch: 'Digit3',
    weakKick: 'Digit4',
    mediumKick: 'Digit5',
    strongKick: 'Digit6',
    guard: 'Digit0',
    throw: 'Enter',
  },
];
window.addEventListener('keydown', (event) => {
  const browserKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Space'];
  if (browserKeys.includes(event.code)) {
    event.preventDefault();
  }
  ensureAudio();
  keys.add(event.code);
});
window.addEventListener('keyup', (event) => {
  keys.delete(event.code);
});
// ブラウザーの音声再生制限に合わせ、キー入力後に音声を準備する
function ensureAudio() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    return;
  }
  if (!audioCtx) {
    audioCtx = new AudioContextClass();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}
function spawnHitEffect(x, y, color) {
  hitEffects.push({ x, y, color, life: 12, maxLife: 12 });
}
// Web Audio APIで簡易ヒット音を作る。ガード時は音色を変える
function playHitSound(kind, guarded) {
  ensureAudio();
  if (!audioCtx) {
    return;
  }
  const now = audioCtx.currentTime;
  const oscillator = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  oscillator.type = guarded ? 'triangle' : 'square';
  oscillator.frequency.setValueAtTime(guarded ? 170 : 110 + kind * 28, now);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(guarded ? 0.025 : 0.08, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
  oscillator.connect(gain);
  gain.connect(audioCtx.destination);
  oscillator.start(now);
  oscillator.stop(now + 0.13);
  if (guarded) {
    return;
  }
  const lowOscillator = audioCtx.createOscillator();
  const lowGain = audioCtx.createGain();
  lowOscillator.type = 'sawtooth';
  lowOscillator.frequency.setValueAtTime(60 + kind * 16, now);
  lowGain.gain.setValueAtTime(0.0001, now);
  lowGain.gain.exponentialRampToValueAtTime(0.03, now + 0.005);
  lowGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
  lowOscillator.connect(lowGain);
  lowGain.connect(audioCtx.destination);
  lowOscillator.start(now);
  lowOscillator.stop(now + 0.1);
}
// ローカルならプレイヤー別キー、オンラインなら両者ともホスト用キーを使う
function inputFor(player) {
  const keySet = keymap[role === 'local' ? player : 0];
  const isLocalPlayer =
    role === 'local' ||
    (role === 'host' && player === 0) ||
    (role === 'guest' && player === 1);
  if (!isLocalPlayer) {
    return remoteInput[player] || {};
  }
  return {
    jump: keys.has(keySet.jump),
    left: keys.has(keySet.left),
    right: keys.has(keySet.right),
    guard: keys.has(keySet.guard),
    weakPunch: keys.has(keySet.weakPunch),
    mediumPunch: keys.has(keySet.mediumPunch),
    strongPunch: keys.has(keySet.strongPunch),
    weakKick: keys.has(keySet.weakKick),
    mediumKick: keys.has(keySet.mediumKick),
    strongKick: keys.has(keySet.strongKick),
    throw: keys.has(keySet.throw),
  };
}
function attackFor(playerIndex, kind) {
  const fighter = fighters[playerIndex];
  if (fighter.attack > 0 || fighter.stun > 0 || gameOver) {
    return;
  }
  const attackDurations = { 1: 17, 2: 20, 3: 23, 4: 18, 5: 21, 6: 24, 7: 25 };
  fighter.attack = attackDurations[kind];
  fighter.attackKind = kind;
  fighter.attackId += 1;
}
// 接続を維持したままラウンド状態を初期化する
function resetRound(notifyPeer = false) {
  fighters = [fresh(), { ...fresh(), x: 710, facing: -1 }];
  remoteInput = [{}, {}];
  prior = [{}, {}];
  remaining = 99;
  gameOver = false;
  screenShake = 0;
  hitEffects.length = 0;
  keys.clear();
  if (role === 'host' && notifyPeer) {
    send({ type: 'state', fighters, remaining, gameOver, rematch: true });
  }
}
// 1回分のゲーム更新。ホストが移動、攻撃判定、HP、残り時間を管理する
function tick(deltaTime) {
  if (role === 'guest' || (role === 'host' && !channel?.open)) {
    return;
  }
  const inputs = [inputFor(0), inputFor(1)];
  const frameScale = deltaTime / 16.667;
  for (let index = 0; index < fighters.length; index += 1) {
    const fighter = fighters[index];
    const opponent = fighters[1 - index];
    const input = inputs[index];
    if (fighter.stun > 0) {
      fighter.stun = Math.max(0, fighter.stun - deltaTime);
      continue;
    }
    const movementSpeed = input.guard ? 1.4 : 2.7;
    if (input.left) {
      fighter.x -= movementSpeed * frameScale;
    }
    if (input.right) {
      fighter.x += movementSpeed * frameScale;
    }
    fighter.x = Math.max(60, Math.min(900, fighter.x));
    if (input.jump && fighter.onGround) {
      fighter.onGround = false;
      fighter.vy = -8.8;
      fighter.jumpDir = input.right ? 1 : input.left ? -1 : 0;
      fighter.facing = opponent.x >= fighter.x ? 1 : -1;
    }
    if (!fighter.onGround) {
      fighter.y += fighter.vy * frameScale;
      fighter.vy += 0.42 * frameScale;
      const airDrift = fighter.jumpDir === 0 ? 0 : fighter.jumpDir;
      fighter.x += airDrift * 1.4 * frameScale;
      if (fighter.y >= 335) {
        fighter.y = 335;
        fighter.vy = 0;
        fighter.onGround = true;
        fighter.jumpDir = 0;
      }
    } else {
      fighter.y = 335;
    }
    fighter.facing = opponent.x >= fighter.x ? 1 : -1;
    fighter.guard = Boolean(input.guard);
    const attacks = [
      ['weakPunch', 1],
      ['mediumPunch', 2],
      ['strongPunch', 3],
      ['weakKick', 4],
      ['mediumKick', 5],
      ['strongKick', 6],
      ['throw', 7],
    ];
    for (const [button, kind] of attacks) {
      if (input[button] && !prior[index][button]) {
        attackFor(index, kind);
      }
    }
    if (fighter.attack > 0) {
      fighter.attack = Math.max(0, fighter.attack - frameScale);
      const active = fighter.attack > 4 && fighter.attack < (fighter.attackKind === 7 ? 18 : 13);
      const horizontalDistance = opponent.x - fighter.x;
      const verticalDistance = Math.abs(opponent.y - fighter.y);
      const attackReach =
        fighter.attackKind === 7 ? 65 :
        fighter.attackKind === 1 ? 78 :
        fighter.attackKind === 2 ? 95 :
        fighter.attackKind === 3 ? 115 :
        fighter.attackKind === 4 ? 88 :
        fighter.attackKind === 5 ? 105 : 125;
      const canHit =
        active &&
        Math.sign(horizontalDistance) === fighter.facing &&
        Math.abs(horizontalDistance) < attackReach &&
        verticalDistance < 47 &&
        fighter.hitId !== fighter.attackId;
      if (canHit) {
        fighter.hitId = fighter.attackId;
        const isGuarded =
          opponent.guard &&
          opponent.facing === -fighter.facing &&
          fighter.attackKind !== 7;
        const damage =
          fighter.attackKind === 1 ? 5 :
          fighter.attackKind === 2 ? 9 :
          fighter.attackKind === 3 ? 14 :
          fighter.attackKind === 4 ? 6 :
          fighter.attackKind === 5 ? 10 :
          fighter.attackKind === 6 ? 15 : 12;
        const appliedDamage = isGuarded ? Math.max(1, Math.floor(damage * 0.18)) : damage;
        opponent.hp = Math.max(0, opponent.hp - appliedDamage);
        if (isGuarded) {
          screenShake = Math.max(screenShake, 3);
          spawnHitEffect(opponent.x, opponent.y - 10, '#63d6d2');
          playHitSound(fighter.attackKind, true);
        } else {
          screenShake = Math.max(screenShake, 8);
          opponent.stun = fighter.attackKind === 7 ? 15 : 8;
          if (fighter.attackKind === 7) {
            opponent.x = Math.max(60, Math.min(900, opponent.x + fighter.facing * 25));
          }
          const effectColor = fighter.attackKind === 7 ? '#63d6d2' : '#ff765f';
          spawnHitEffect(opponent.x, opponent.y - 10, effectColor);
          playHitSound(fighter.attackKind, false);
        }
      }
    }
    prior[index] = input;
  }
  if (fighters.some((fighter) => fighter.hp <= 0)) {
    gameOver = true;
  }
  remaining = Math.max(0, remaining - deltaTime / 1000);
  if (remaining === 0) {
    gameOver = true;
  }
}
function draw() {
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.translate(
    (Math.random() - 0.5) * screenShake,
    (Math.random() - 0.5) * screenShake,
  );
  ctx.fillStyle = '#1a2725';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#202d2a';
  ctx.fillRect(0, 250, width, 180);
  ctx.strokeStyle = '#40504a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, 250);
  ctx.lineTo(width, 250);
  ctx.moveTo(0, 430);
  ctx.lineTo(width, 430);
  ctx.stroke();
  ctx.fillStyle = '#364b46';
  for (let x = 0; x < width; x += 40) {
    ctx.fillRect(x, 250, 16, 10);
  }
  ctx.fillStyle = '#d4fa5810';
  ctx.fillRect(0, 0, width, 4);
  fighters.forEach((fighter, index) => drawFighter(fighter, index));
  drawHitEffects();
  ctx.restore();
  screenShake = Math.max(0, screenShake - 0.7);
  drawGameOver(width, height);
  updateHud();
}
function drawHitEffects() {
  for (let index = hitEffects.length - 1; index >= 0; index -= 1) {
    const effect = hitEffects[index];
    effect.life -= 1;
    const alpha = effect.life / effect.maxLife;
    if (alpha <= 0) {
      hitEffects.splice(index, 1);
      continue;
    }
    ctx.fillStyle = effect.color;
    ctx.globalAlpha = alpha;
    ctx.fillRect(effect.x - 8, effect.y - 8, 16, 16);
    ctx.fillRect(effect.x - 18, effect.y - 2, 36, 4);
    ctx.fillRect(effect.x - 2, effect.y - 18, 4, 36);
    ctx.globalAlpha = 1;
  }
}
function drawGameOver(width, height) {
  if (!gameOver) {
    return;
  }
  ctx.fillStyle = '#0c1110aa';
  ctx.fillRect(0, 0, width, height);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#f4f0e5';
  ctx.font = '700 52px "Barlow Condensed", sans-serif';
  const winner =
    fighters[0].hp === fighters[1].hp ? 'DRAW' :
    fighters[0].hp > fighters[1].hp ? 'HOST WINS' : 'GUEST WINS';
  ctx.fillText(winner, width / 2, height / 2);
  ctx.font = '600 17px sans-serif';
  ctx.fillStyle = '#d4fa58';
  ctx.fillText('切断 / リセットで再戦', width / 2, height / 2 + 38);
}
function updateHud() {
  document.getElementById('hp1').style.width = `${fighters[0].hp}%`;
  document.getElementById('hp2').style.width = `${fighters[1].hp}%`;
  document.getElementById('timer').textContent = String(Math.ceil(remaining)).padStart(2, '0');
}
function drawFighter(fighter, index) {
  const { x, y, facing, guard, attack, attackKind } = fighter;
  const primaryColor = index === 0 ? '#d4fa58' : '#ff765f';
  const darkColor = index === 0 ? '#788f31' : '#a5423a';
  ctx.fillStyle = '#111918';
  ctx.fillRect(x - 26, y + 12, 52, 6);
  ctx.fillStyle = darkColor;
  ctx.fillRect(x - 16, y - 30, 32, 38);
  ctx.fillStyle = primaryColor;
  ctx.fillRect(x - 13, y - 33, 26, 31);
  ctx.fillStyle = '#1d2521';
  ctx.fillRect(x + (facing === 1 ? 2 : -8), y - 27, 6, 4);
  ctx.fillStyle = darkColor;
  ctx.fillRect(x - 15, y + 8, 10, 14);
  ctx.fillRect(x + 5, y + 8, 10, 14);
  ctx.fillStyle = primaryColor;
  ctx.fillRect(x - 16, y + 22, 12, 6);
  ctx.fillRect(x + 4, y + 22, 12, 6);
  ctx.fillStyle = darkColor;
  ctx.fillRect(x + (facing === 1 ? 8 : -20), y - 23, 16, 8);
  if (guard) {
    ctx.strokeStyle = '#63d6d2';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(x, y - 10, 30, -1.2, 1.2);
    ctx.stroke();
  }
  if (attack > 0) {
    if (attackKind >= 4 && attackKind <= 6) {
      const kickReach = attackKind === 4 ? 45 : attackKind === 5 ? 60 : 76;
      ctx.fillStyle = darkColor;
      ctx.fillRect(x + facing * 8, y + 5, facing * (kickReach - 8), 9);
      ctx.fillStyle = primaryColor;
      ctx.fillRect(x + facing * (kickReach - 3), y + 4, facing * 12, 11);
    } else {
      const attackReach =
        attackKind === 1 ? 45 :
        attackKind === 2 ? 60 :
        attackKind === 3 ? 76 : 43;
      ctx.fillStyle = attackKind === 7 ? '#63d6d2aa' : `${primaryColor}aa`;
      ctx.fillRect(x + facing * 18, y - 17, facing * attackReach, 12);
    }
  }
}
// PeerJSで接続した相手へゲームデータを送る
function send(message) {
  if (!channel?.open) {
    return;
  }
  try {
    channel.send(message);
  } catch {
    // 接続終了と送信が重なった場合は何もしない
  }
}
function setConnectionStatus(message, connected = false) {
  const status = document.getElementById('connectionStatus');
  status.classList.toggle('connected', connected);
  status.querySelector('span').textContent = message;
}
function setConnected() {
  const playerLabel = role === 'host' ? 'あなたはホスト' : 'あなたは参加者';
  setConnectionStatus(`P2P接続中 · ${playerLabel}`, true);
  document.getElementById('playNote').textContent =
    'オンライン共通: A/D 移動 · W ジャンプ · U/I/O パンチ · J/K/L キック · T ガード · R 投げ';
}
// DataConnectionを受け取り、既存のゲーム同期メッセージを処理する
function setupChannel(connection) {
  if (channel && channel !== connection) {
    connection.close();
    return;
  }
  channel = connection;
  connection.on('open', () => {
    if (channel !== connection) {
      return;
    }
    setConnected();
    if (role === 'host') {
      send({ type: 'state', fighters, remaining, frame: 0 });
    }
  });
  connection.on('close', () => {
    if (channel !== connection) {
      return;
    }
    channel = null;
    setConnectionStatus('通信が切断されました');
  });
  connection.on('error', (error) => {
    if (channel === connection) {
      setConnectionStatus(`通信エラー: ${error.message}`);
    }
  });
  connection.on('data', (message) => {
    if (!message || typeof message !== 'object') {
      return;
    }
    if (message.type === 'input' && role === 'host') {
      remoteInput[1] = message.input;
    }
    if (message.type === 'rematch' && role === 'host') {
      resetRound(true);
    }
    if (message.type === 'state' && role === 'guest') {
      fighters = message.fighters;
      remaining = message.remaining;
      gameOver = message.gameOver;
      if (message.rematch) {
        setConnected();
      }
    }
    if (message.type === 'ping') {
      send({ type: 'pong', t: message.t });
    }
    if (message.type === 'pong') {
      const roundTripTime = performance.now() - message.t;
      history.push(roundTripTime);
      if (history.length > 80) {
        history.shift();
      }
      updateNetwork();
    }
  });
}
// PeerJSのIDを共有用コードにし、接続先を管理する
function closePeer() {
  const oldPeer = peer;
  const oldChannel = channel;
  peer = null;
  channel = null;
  oldChannel?.close();
  oldPeer?.destroy();
}
function createPeer() {
  if (!window.Peer) {
    throw new Error('PeerJSを読み込めません。ページを再読み込みしてください');
  }
  const currentPeer = new Peer();
  peer = currentPeer;
  currentPeer.on('error', (error) => {
    if (peer !== currentPeer) {
      return;
    }
    const errorMessages = {
      'peer-unavailable': '参加先が見つかりません。部屋コードを確認してください。',
      network: '接続サービスに接続できません。',
      'server-error': '接続サービスでエラーが発生しました。',
      'unavailable-id': '部屋コードを作成できません。もう一度試してください。',
    };
    setConnectionStatus(errorMessages[error.type] || `接続エラー: ${error.message}`);
  });
  return currentPeer;
}
// ホストがPeer IDを作り、ゲストに共有する
const createRoomButton = document.getElementById('createRoomBtn');
createRoomButton.addEventListener('click', () => {
  closePeer();
  role = 'host';
  resetRound();
  const roomCodeInput = document.getElementById('roomCode');
  const copyButton = document.getElementById('copyRoomBtn');
  roomCodeInput.value = '';
  copyButton.disabled = true;
  copyButton.textContent = 'コードをコピー';
  setConnectionStatus('部屋を作成しています…');
  try {
    const hostPeer = createPeer();
    hostPeer.on('open', (id) => {
      if (peer !== hostPeer) {
        return;
      }
      roomCodeInput.value = id;
      copyButton.disabled = false;
      setConnectionStatus('部屋を作成しました。コードを共有してください。');
    });
    hostPeer.on('connection', (connection) => {
      if (channel) {
        connection.close();
        return;
      }
      setConnectionStatus('参加者が接続しています…');
      setupChannel(connection);
    });
  } catch (error) {
    setConnectionStatus(error.message);
  }
});
const copyRoomButton = document.getElementById('copyRoomBtn');
copyRoomButton.addEventListener('click', async () => {
  const roomCodeInput = document.getElementById('roomCode');
  if (!roomCodeInput.value) {
    return;
  }
  try {
    await navigator.clipboard.writeText(roomCodeInput.value);
  } catch {
    roomCodeInput.select();
    document.execCommand('copy');
  }
  copyRoomButton.textContent = 'コピーしました';
  setTimeout(() => {
    copyRoomButton.textContent = 'コードをコピー';
  }, 1200);
});
// ゲストは入力された部屋コードへ接続する
const joinRoomButton = document.getElementById('joinRoomBtn');
joinRoomButton.addEventListener('click', () => {
  const code = document.getElementById('joinCodeInput').value.trim();
  if (!code) {
    setConnectionStatus('参加コードを入力してください');
    return;
  }
  closePeer();
  role = 'guest';
  resetRound();
  setConnectionStatus('部屋に接続しています…');
  try {
    const guestPeer = createPeer();
    guestPeer.on('open', () => {
      if (peer !== guestPeer) {
        return;
      }
      const connection = guestPeer.connect(code, {
        reliable: true,
        serialization: 'json',
      });
      setupChannel(connection);
    });
  } catch (error) {
    setConnectionStatus(error.message);
  }
});
const rematchButton = document.getElementById('rematchBtn');
rematchButton.addEventListener('click', () => {
  if (role === 'guest') {
    if (!channel?.open) {
      setConnectionStatus('通信が接続されていません');
      return;
    }
    send({ type: 'rematch' });
    setConnectionStatus('再戦をホストにリクエストしました');
    return;
  }
  resetRound(role === 'host');
});
// 切断してローカル練習の初期状態に戻す
const resetButton = document.getElementById('resetBtn');
resetButton.addEventListener('click', () => {
  closePeer();
  role = 'local';
  resetRound();
  history = [];
  document.getElementById('roomCode').value = '';
  document.getElementById('joinCodeInput').value = '';
  document.getElementById('copyRoomBtn').disabled = true;
  document.getElementById('copyRoomBtn').textContent = 'コードをコピー';
  setConnectionStatus('ローカル練習モード');
  document.getElementById('playNote').textContent =
    'ローカル練習 · 1P: A/D 移動 + W ジャンプ / 斜めジャンプ + U/I/O パンチ・J/K/L キック · 2P: ←/→ 移動 + ↑ ジャンプ / 斜めジャンプ';
  updateNetwork();
});
// RTTを画面とグラフに表示する
function updateNetwork() {
  const latest = history.length > 0 ? history[history.length - 1] : null;
  document.getElementById('pingValue').textContent =
    latest === null ? '--' : Math.round(latest);
  const quality = document.getElementById('netQuality');
  quality.textContent =
    latest === null ? 'WAITING' :
    latest <= 50 ? '≤ 3 FRAMES' : 'OVER 3 FRAMES';
  quality.style.color =
    latest === null ? '#9ea7a5' :
    latest <= 50 ? '#d4fa58' : '#ff765f';
  document.getElementById('frameValue').textContent =
    latest === null
      ? '3フレーム目安: 50ms以下'
      : `${(latest / 16.667).toFixed(1)}フレーム相当 · 目安50ms以下`;
  const graph = document.getElementById('graph');
  const graphContext = graph.getContext('2d');
  const width = graph.width;
  const height = graph.height;
  graphContext.clearRect(0, 0, width, height);
  graphContext.fillStyle = '#101716';
  graphContext.fillRect(0, 0, width, height);
  graphContext.strokeStyle = '#ffffff12';
  for (let y = 25; y < height; y += 25) {
    graphContext.beginPath();
    graphContext.moveTo(0, y);
    graphContext.lineTo(width, y);
    graphContext.stroke();
  }
  const threshold = height - (50 / 200) * height;
  graphContext.setLineDash([5, 4]);
  graphContext.strokeStyle = '#d4fa5870';
  graphContext.beginPath();
  graphContext.moveTo(0, threshold);
  graphContext.lineTo(width, threshold);
  graphContext.stroke();
  graphContext.setLineDash([]);
  if (history.length > 0) {
    graphContext.beginPath();
    history.forEach((value, index) => {
      const x = (index / Math.max(79, history.length - 1)) * (width - 4) + 2;
      const y = height - 4 - (Math.min(value, 190) / 200) * (height - 8);
      if (index === 0) {
        graphContext.moveTo(x, y);
      } else {
        graphContext.lineTo(x, y);
      }
    });
    graphContext.strokeStyle = latest <= 50 ? '#d4fa58' : '#ff765f';
    graphContext.lineWidth = 2;
    graphContext.stroke();
  }
}
// フレームごとにゲーム更新、送受信、描画を行う
function loop(now) {
  const deltaTime = Math.min(40, now - lastFrame);
  lastFrame = now;
  if (!gameOver) {
    tick(deltaTime);
    if (role === 'guest' && now - lastSent > 25) {
      send({ type: 'input', input: inputFor(1) });
      lastSent = now;
    }
    if (role === 'host' && now - lastState > 33) {
      send({ type: 'state', fighters, remaining, gameOver });
      lastState = now;
    }
    if (channel?.open && now - pingAt > 700) {
      send({ type: 'ping', t: now });
      pingAt = now;
    }
  }
  draw();
  requestAnimationFrame(loop);
}
updateNetwork();
requestAnimationFrame(loop);
