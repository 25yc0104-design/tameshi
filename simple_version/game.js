'use strict';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const keys = new Set();
const hpBars = [document.getElementById('hp1'), document.getElementById('hp2')];
const timerDisplay = document.getElementById('timer');
const resultDisplay = document.getElementById('result');
const connectionStatus = document.getElementById('connectionStatus');
let peer = null;
let channel = null;
let role = 'local';
let pingAt = 0;
let handshakeTimeout = null;
const FIXED_STEP_MS = 1000 / 60;
const MAX_ROLLBACK_FRAMES = 180;
const MAX_STEPS_PER_RENDER = 5;
const PROTOCOL_VERSION = 2;
let simulationAccumulator = 0;
let simulationFrame = 0;
let onlineStarted = false;
let syncPaused = false;
let syncEpoch = 0;
let pendingResyncToken = null;
let resyncTokenSequence = 0;
const frameInputs = new Map();
const receivedRemoteInputs = new Map();
const frameStates = new Map();

const keymap = [
  {
    left: 'KeyA',
    right: 'KeyD',
    jump: 'KeyW',
    down: 'KeyS',
    weak: 'KeyU',
    medium: 'KeyI',
    strong: 'KeyO',
    special: 'KeyR',
  },
  {
    left: 'ArrowLeft',
    right: 'ArrowRight',
    jump: 'ArrowUp',
    down: 'ArrowDown',
    weak: 'Digit1',
    medium: 'Digit2',
    strong: 'Digit3',
    special: 'Digit4',
  },
];

const attackList = [
  ['weak', 1],
  ['medium', 2],
  ['strong', 3],
  ['special', 4],
];

const damageByAttack = [0, 5, 9, 14, 20];
const reachByAttack = [0, 78, 95, 115, 125];
const attackTimings = [
  null,
  { startup: 6, active: 3, recovery: 9 },
  { startup: 8, active: 3, recovery: 12 },
  { startup: 14, active: 3, recovery: 18 },
  { total: 28 },
];
let fighters;
let previousInput;
let remaining;
let gameOver;
let lastFrame = performance.now();
let screenShake = 0;

function createFighter(x, facing, color, darkColor) {
  return {
    x,
    y: 335,
    vy: 0,
    onGround: true,
    jumpDir: 0,
    hp: 100,
    facing,
    color,
    darkColor,
    guard: false,
    attack: 0,
    attackFrame: 0,
    attackKind: 0,
    attackId: 0,
    hitId: 0,
    stun: 0,
    guardFlash: 0,
  };
}

function resetRound() {
  fighters = [
    createFighter(250, 1, '#d4fa58', '#788f31'),
    createFighter(710, -1, '#ff765f', '#a5423a'),
  ];
  previousInput = [{}, {}];
  remaining = 99;
  gameOver = false;
  screenShake = 0;
  simulationFrame = 0;
  simulationAccumulator = 0;
  onlineStarted = role === 'local';
  syncPaused = false;
  pendingResyncToken = null;
  clearRollbackHistory();
  resultDisplay.textContent = '';
  updateHud();
}

function inputFor(player) {
  const layout = keymap[player];
  const input = {};
  for (const [action, code] of Object.entries(layout)) {
    input[action] = keys.has(code);
  }
  return input;
}

function startAttack(fighter, kind) {
  if (fighter.attack > 0 || fighter.stun > 0 || gameOver) {
    return;
  }
  const timing = attackTimings[kind];
  fighter.attack = timing.total ?? timing.startup + timing.active + timing.recovery;
  fighter.attackFrame = 0;
  fighter.attackKind = kind;
  fighter.attackId += 1;
}

function simulateGameFrame(inputs) {
  if (gameOver) {
    screenShake = Math.max(0, screenShake - 0.7);
    return;
  }

  const frameScale = 1;

  for (let index = 0; index < fighters.length; index += 1) {
    const fighter = fighters[index];
    const opponent = fighters[1 - index];
    const input = inputs[index];
    fighter.guardFlash = Math.max(0, fighter.guardFlash - frameScale);

    if (fighter.stun > 0) {
      fighter.stun = Math.max(0, fighter.stun - frameScale);
      fighter.guard = false;
      previousInput[index] = input;
      continue;
    }

    fighter.facing = opponent.x >= fighter.x ? 1 : -1;
    const holdingBackward = fighter.facing === 1 ? input.left : input.right;
    for (const [button, kind] of attackList) {
      if (input[button] && !previousInput[index][button]) {
        startAttack(fighter, kind);
      }
    }

    const attacking = fighter.attack > 0;
    fighter.guard = Boolean(!attacking && input.down && holdingBackward);
    if (fighter.guard) {
      previousInput[index] = input;
      continue;
    }

    if (!attacking) {
      const speed = 2.7;
      if (input.left) fighter.x -= speed * frameScale;
      if (input.right) fighter.x += speed * frameScale;
      fighter.x = Math.max(60, Math.min(900, fighter.x));

      if (input.jump && fighter.onGround) {
        fighter.onGround = false;
        fighter.vy = -8.8;
        fighter.jumpDir = input.right ? 1 : input.left ? -1 : 0;
      }
    }

    if (!fighter.onGround) {
      fighter.y += fighter.vy * frameScale;
      fighter.vy += 0.42 * frameScale;
      if (!attacking) {
        fighter.x += fighter.jumpDir * 1.4 * frameScale;
      }
      if (fighter.y >= 335) {
        fighter.y = 335;
        fighter.vy = 0;
        fighter.onGround = true;
        fighter.jumpDir = 0;
      }
    }

    fighter.facing = opponent.x >= fighter.x ? 1 : -1;

    if (fighter.attack > 0) {
      fighter.attack = Math.max(0, fighter.attack - frameScale);
      fighter.attackFrame += frameScale;
      const specialAttack = fighter.attackKind === 4;
      const timing = attackTimings[fighter.attackKind];
      const active = specialAttack
        ? fighter.attack > 4 && fighter.attack < 18
        : fighter.attackFrame >= timing.startup &&
          fighter.attackFrame < timing.startup + timing.active;
      const distance = opponent.x - fighter.x;
      const inRange =
        active &&
        Math.sign(distance) === fighter.facing &&
        Math.abs(distance) < reachByAttack[fighter.attackKind] &&
        Math.abs(opponent.y - fighter.y) < 47 &&
        fighter.hitId !== fighter.attackId;

      if (inRange) {
        fighter.hitId = fighter.attackId;
        const guarded =
          opponent.guard &&
          opponent.facing === -fighter.facing;
        const damage = damageByAttack[fighter.attackKind];
        opponent.hp = Math.max(
          0,
          opponent.hp - (guarded ? Math.max(1, Math.floor(damage * 0.18)) : damage),
        );

        screenShake = Math.max(screenShake, guarded ? 3 : 8);
        if (guarded) {
          opponent.guardFlash = 8;
        } else {
          opponent.stun = specialAttack ? 15 : 8;
        }
      }
    }
    previousInput[index] = input;
  }

  screenShake = Math.max(0, screenShake - 0.7);
  remaining = Math.max(0, remaining - 1 / 60);
  if (fighters.some((fighter) => fighter.hp <= 0) || remaining === 0) {
    gameOver = true;
  }
}

function drawArena() {
  ctx.fillStyle = '#1a2725';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#202d2a';
  ctx.fillRect(0, 250, canvas.width, 180);
  ctx.strokeStyle = '#40504a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, 250);
  ctx.lineTo(canvas.width, 250);
  ctx.moveTo(0, 430);
  ctx.lineTo(canvas.width, 430);
  ctx.stroke();
  ctx.fillStyle = '#364b46';
  for (let x = 0; x < canvas.width; x += 40) {
    ctx.fillRect(x, 250, 16, 10);
  }
}

function drawFighter(fighter) {
  const { x, y, facing, attack, attackKind, color, darkColor, guardFlash } = fighter;
  ctx.fillStyle = '#111918';
  ctx.fillRect(x - 26, y + 12, 52, 6);

  ctx.fillStyle = darkColor;
  ctx.fillRect(x - 16, y - 30, 32, 38);
  ctx.fillStyle = color;
  ctx.fillRect(x - 13, y - 33, 26, 31);
  ctx.fillStyle = '#1d2521';
  ctx.fillRect(x + (facing === 1 ? 2 : -8), y - 27, 6, 4);
  ctx.fillStyle = darkColor;
  ctx.fillRect(x - 15, y + 8, 10, 14);
  ctx.fillRect(x + 5, y + 8, 10, 14);
  ctx.fillStyle = color;
  ctx.fillRect(x - 16, y + 22, 12, 6);
  ctx.fillRect(x + 4, y + 22, 12, 6);
  ctx.fillStyle = darkColor;
  ctx.fillRect(x + (facing === 1 ? 8 : -20), y - 23, 16, 8);

  if (guardFlash > 0) {
    ctx.save();
    ctx.globalAlpha = guardFlash / 8;
    ctx.strokeStyle = '#b7ffff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x + facing * 22, y - 10, 20 + (8 - guardFlash) * 2, -1.15, 1.15);
    ctx.stroke();
    ctx.fillStyle = '#eaffff';
    ctx.beginPath();
    ctx.arc(x + facing * 34, y - 18, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  if (attack <= 0) {
    return;
  }
  const attackReach =
    attackKind === 1 ? 45 :
    attackKind === 2 ? 60 :
    attackKind === 3 ? 76 : 86;
  ctx.fillStyle = attackKind === 4 ? '#63d6d2aa' : `${color}aa`;
  ctx.fillRect(x + facing * 18, y - 17, facing * attackReach, 12);
}

function drawGameOver() {
  if (!gameOver) {
    resultDisplay.textContent = '';
    return;
  }
  ctx.fillStyle = '#0c1110aa';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const winner =
    fighters[0].hp === fighters[1].hp
      ? 'DRAW'
      : fighters[0].hp > fighters[1].hp
        ? 'PLAYER 1 WINS'
        : 'PLAYER 2 WINS';
  resultDisplay.textContent = `${winner} · リスタートで再戦`;
}

function updateHud() {
  hpBars[0].style.width = `${fighters[0].hp}%`;
  hpBars[1].style.width = `${fighters[1].hp}%`;
  timerDisplay.textContent = String(Math.ceil(remaining)).padStart(2, '0');
}

const inputActions = ['left', 'right', 'jump', 'down', 'weak', 'medium', 'strong', 'special'];

function normalizeInput(input) {
  const normalized = {};
  for (const action of inputActions) {
    normalized[action] = Boolean(input?.[action]);
  }
  return normalized;
}

function neutralInput() {
  return normalizeInput({});
}

function cloneState() {
  return {
    fighters: fighters.map((fighter) => ({ ...fighter })),
    previousInput: previousInput.map((input) => ({ ...input })),
    remaining,
    gameOver,
    screenShake,
  };
}

function restoreState(state) {
  fighters = state.fighters.map((fighter) => ({ ...fighter }));
  previousInput = state.previousInput.map((input) => ({ ...input }));
  remaining = state.remaining;
  gameOver = state.gameOver;
  screenShake = state.screenShake;
}

function isValidState(state) {
  if (
    !state ||
    !Array.isArray(state.fighters) ||
    state.fighters.length !== 2 ||
    !Array.isArray(state.previousInput) ||
    state.previousInput.length !== 2 ||
    !Number.isFinite(state.remaining) ||
    typeof state.gameOver !== 'boolean' ||
    !Number.isFinite(state.screenShake)
  ) {
    return false;
  }
  const fighterNumbers = [
    'x', 'y', 'vy', 'jumpDir', 'hp', 'facing', 'attack', 'attackFrame',
    'attackKind', 'attackId', 'hitId', 'stun', 'guardFlash',
  ];
  return state.fighters.every((fighter) =>
    fighter &&
    fighterNumbers.every((key) => Number.isFinite(fighter[key])) &&
    typeof fighter.onGround === 'boolean' &&
    typeof fighter.guard === 'boolean' &&
    typeof fighter.color === 'string' &&
    typeof fighter.darkColor === 'string',
  ) && state.previousInput.every((input) =>
    input && typeof input === 'object' && !Array.isArray(input),
  );
}

function clearRollbackHistory() {
  frameInputs.clear();
  receivedRemoteInputs.clear();
  frameStates.clear();
  frameStates.set(simulationFrame, cloneState());
}

function pruneRollbackHistory() {
  const oldestFrame = simulationFrame - MAX_ROLLBACK_FRAMES;
  for (const frame of frameInputs.keys()) {
    if (frame < oldestFrame - 1) {
      frameInputs.delete(frame);
    }
  }
  for (const frame of receivedRemoteInputs.keys()) {
    if (frame < oldestFrame) {
      receivedRemoteInputs.delete(frame);
    }
  }
  for (const frame of frameStates.keys()) {
    if (frame < oldestFrame) {
      frameStates.delete(frame);
    }
  }
}

function remoteInputForFrame(frame, remotePlayer) {
  const received = receivedRemoteInputs.get(frame);
  if (received) {
    return received;
  }
  return frameInputs.get(frame - 1)?.[remotePlayer] || neutralInput();
}

function simulateFrame(localInputs = null) {
  if (role === 'local') {
    simulateGameFrame(localInputs || [inputFor(0), inputFor(1)]);
    simulationFrame += 1;
    return;
  }
  if (!onlineStarted || syncPaused || !channel?.open) {
    return;
  }

  const frame = simulationFrame;
  const localPlayer = role === 'host' ? 0 : 1;
  const remotePlayer = 1 - localPlayer;
  const inputs = [];
  inputs[localPlayer] = normalizeInput(localInputs || inputFor(localPlayer));
  inputs[remotePlayer] = remoteInputForFrame(frame, remotePlayer);
  frameInputs.set(frame, inputs.map(normalizeInput));
  frameStates.set(frame, cloneState());
  simulateGameFrame(inputs);
  simulationFrame = frame + 1;
  pruneRollbackHistory();
  send({
    type: 'input',
    protocol: PROTOCOL_VERSION,
    epoch: syncEpoch,
    frame,
    input: inputs[localPlayer],
  });
}

function inputsMatch(first, second) {
  return inputActions.every((action) => Boolean(first?.[action]) === Boolean(second?.[action]));
}

function rollbackFrom(frame) {
  const startState = frameStates.get(frame);
  if (!startState) {
    pauseForResync(frame);
    return;
  }

  const endFrame = simulationFrame;
  for (let replayFrame = frame; replayFrame < endFrame; replayFrame += 1) {
    if (!frameInputs.has(replayFrame)) {
      pauseForResync(replayFrame);
      return;
    }
  }

  const localPlayer = role === 'host' ? 0 : 1;
  const remotePlayer = 1 - localPlayer;
  restoreState(startState);
  for (let replayFrame = frame; replayFrame < endFrame; replayFrame += 1) {
    const savedInputs = frameInputs.get(replayFrame);
    const inputs = [];
    inputs[localPlayer] = savedInputs[localPlayer];
    inputs[remotePlayer] = remoteInputForFrame(replayFrame, remotePlayer);
    frameStates.set(replayFrame, cloneState());
    frameInputs.set(replayFrame, inputs.map(normalizeInput));
    simulateGameFrame(inputs);
    simulationFrame = replayFrame + 1;
  }
  pruneRollbackHistory();
}

function receiveRemoteInput(message) {
  if (
    message.protocol !== PROTOCOL_VERSION ||
    message.epoch !== syncEpoch ||
    !Number.isInteger(message.frame) ||
    message.frame < 0 ||
    !message.input ||
    typeof message.input !== 'object' ||
    Array.isArray(message.input)
  ) {
    return;
  }
  const frame = message.frame;
  if (frame > simulationFrame + MAX_ROLLBACK_FRAMES) {
    pauseForResync(frame);
    return;
  }
  const input = normalizeInput(message.input);
  const existing = receivedRemoteInputs.get(frame);
  if (existing && inputsMatch(existing, input)) {
    return;
  }
  receivedRemoteInputs.set(frame, input);
  if (frame >= simulationFrame) {
    return;
  }

  const usedInput = frameInputs.get(frame)?.[role === 'host' ? 1 : 0];
  if (!usedInput) {
    pauseForResync(frame);
  } else if (!inputsMatch(usedInput, input)) {
    rollbackFrom(frame);
  }
}

function pauseForResync(frame) {
  if (syncPaused || !channel?.open) {
    return;
  }
  syncPaused = true;
  if (role === 'host') {
    const token = ++resyncTokenSequence;
    pendingResyncToken = token;
    syncEpoch += 1;
    send({
      type: 'resync-state',
      protocol: PROTOCOL_VERSION,
      token,
      epoch: syncEpoch,
      frame: simulationFrame,
      state: cloneState(),
    });
  } else {
    const token = ++resyncTokenSequence;
    pendingResyncToken = token;
    send({
      type: 'resync-request',
      protocol: PROTOCOL_VERSION,
      token,
      epoch: syncEpoch,
      frame,
    });
  }
  setConnectionStatus('通信遅延のため同期中です。ゲーム進行を一時停止しています。');
}

function acceptResyncState(message) {
  if (
    message.protocol !== PROTOCOL_VERSION ||
    !Number.isInteger(message.token) ||
    !Number.isInteger(message.epoch) ||
    !Number.isInteger(message.frame) ||
    message.frame < 0 ||
    !isValidState(message.state)
  ) {
    setConnectionStatus('受信した同期データが不正です。接続をやり直してください。');
    return;
  }
  if (role === 'guest' && pendingResyncToken !== null && pendingResyncToken !== message.token) {
    return;
  }
  syncPaused = true;
  syncEpoch = message.epoch;
  simulationFrame = message.frame;
  simulationAccumulator = 0;
  restoreState(message.state);
  clearRollbackHistory();
  pendingResyncToken = message.token;
  send({
    type: 'resync-ack',
    protocol: PROTOCOL_VERSION,
    token: message.token,
    epoch: syncEpoch,
  });
  if (role === 'guest') {
    syncPaused = false;
    pendingResyncToken = null;
    setConnectionStatus('オンライン対戦中（同期を再開しました）');
  }
}

function beginOnlineRound(message) {
  if (
    message.protocol !== PROTOCOL_VERSION ||
    !Number.isInteger(message.epoch) ||
    !Number.isInteger(message.frame) ||
    message.frame < 0 ||
    !isValidState(message.state)
  ) {
    setConnectionStatus('通信相手のゲームバージョンが異なります。両方を再読み込みしてください。');
    return;
  }
  clearTimeout(handshakeTimeout);
  handshakeTimeout = null;
  syncEpoch = message.epoch;
  simulationFrame = message.frame;
  simulationAccumulator = 0;
  restoreState(message.state);
  onlineStarted = true;
  syncPaused = false;
  pendingResyncToken = null;
  clearRollbackHistory();
  lastFrame = performance.now();
  setConnectionStatus(`オンライン対戦中（${role === 'host' ? 'ホスト' : 'ゲスト'}）`);
}

function startOnlineRound() {
  resetRound();
  syncEpoch += 1;
  onlineStarted = true;
  lastFrame = performance.now();
  send({
    type: 'round-start',
    protocol: PROTOCOL_VERSION,
    epoch: syncEpoch,
    frame: simulationFrame,
    state: cloneState(),
  });
  setConnectionStatus(`オンライン対戦中（${role === 'host' ? 'ホスト' : 'ゲスト'}）`);
}

function updateFrameMeter() {
  const frameMeter = document.getElementById('frameMeter');
  frameMeter.hidden = role !== 'local';
  if (frameMeter.hidden) {
    return;
  }

  const attackNames = ['', '弱攻撃', '中攻撃', '強攻撃', '必殺技'];
  fighters.forEach((fighter, index) => {
    const playerNumber = index + 1;
    const marker = document.getElementById(`frameMarker${playerNumber}`);
    const status = document.getElementById(`frameStatus${playerNumber}`);
    const track = marker.parentElement;

    if (fighter.attackKind === 0) {
      status.textContent = '待機';
      track.dataset.running = 'false';
      track.dataset.active = '';
      track.style.gridTemplateColumns = '6fr 3fr 9fr';
      marker.style.left = '0%';
      return;
    }

    const configuredTiming = attackTimings[fighter.attackKind];
    const timing = configuredTiming.active === undefined
      ? fighter.attackKind === 4
        ? { startup: 10, active: 13, recovery: 5 }
        : { startup: configuredTiming.startup, active: 0, recovery: configuredTiming.recovery }
      : configuredTiming;
    const total = timing.startup + timing.active + timing.recovery;
    const frame = Math.min(total, Math.ceil(fighter.attackFrame));
    let phase = 'recovery';
    let phaseLabel = '硬直';
    if (fighter.attack > 0) {
      if (fighter.attackKind === 4) {
        if (fighter.attack > 4 && fighter.attack < 18) {
          phase = 'active';
          phaseLabel = '持続';
        } else if (fighter.attack >= 18) {
          phase = 'startup';
          phaseLabel = '発生';
        }
      } else if (frame < timing.startup) {
        phase = 'startup';
        phaseLabel = '発生';
      } else if (frame < timing.startup + timing.active) {
        phase = 'active';
        phaseLabel = '持続';
      }
      status.textContent = `${attackNames[fighter.attackKind]} · ${phaseLabel} · ${frame}F / ${total}F`;
      track.dataset.running = 'true';
      track.dataset.active = phase;
    } else {
      status.textContent = `${attackNames[fighter.attackKind]} · 終了 · ${total}F`;
      track.dataset.running = 'false';
      track.dataset.active = '';
    }

    track.style.gridTemplateColumns =
      `${timing.startup}fr ${timing.active}fr ${timing.recovery}fr`;
    marker.style.left = `${Math.min(100, (frame / total) * 100)}%`;
  });
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate((Math.random() - 0.5) * screenShake, (Math.random() - 0.5) * screenShake);
  drawArena();
  fighters.forEach(drawFighter);
  ctx.restore();
  drawGameOver();
  updateHud();
  updateFrameMeter();
}

function loop(now) {
  const deltaTime = Math.min(250, now - lastFrame);
  lastFrame = now;
  simulationAccumulator += deltaTime;
  let steps = 0;
  while (simulationAccumulator >= FIXED_STEP_MS && steps < MAX_STEPS_PER_RENDER) {
    simulateFrame();
    simulationAccumulator -= FIXED_STEP_MS;
    steps += 1;
  }
  if (channel?.open && now - pingAt > 700) {
    send({ type: 'ping', t: now });
    pingAt = now;
  }
  draw();
  requestAnimationFrame(loop);
}

window.addEventListener('keydown', (event) => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.code)) {
    event.preventDefault();
  }
  keys.add(event.code);
});

window.addEventListener('keyup', (event) => {
  keys.delete(event.code);
});

window.addEventListener('blur', () => {
  keys.clear();
});

function send(message) {
  if (!channel?.open) {
    return;
  }
  try {
    channel.send(message);
  } catch (error) {
    setConnectionStatus(`通信エラー: ${error.message}`);
  }
}

function setConnectionStatus(message) {
  connectionStatus.textContent = message;
}

function closePeer() {
  const oldPeer = peer;
  const oldChannel = channel;
  peer = null;
  channel = null;
  clearTimeout(handshakeTimeout);
  handshakeTimeout = null;
  onlineStarted = false;
  syncPaused = false;
  oldChannel?.close();
  oldPeer?.destroy();
}

function createPeer() {
  if (!window.Peer) {
    throw new Error('PeerJSを読み込めません。インターネット接続を確認してページを再読み込みしてください。');
  }
  const currentPeer = new Peer();
  peer = currentPeer;
  currentPeer.on('error', (error) => {
    if (peer !== currentPeer) {
      return;
    }
    const messages = {
      'peer-unavailable': '部屋が見つかりません。コードを確認してください。',
      network: '接続サービスに接続できません。',
      'server-error': '接続サービスでエラーが発生しました。',
      'unavailable-id': '部屋を作成できません。もう一度お試しください。',
    };
    setConnectionStatus(messages[error.type] || `接続エラー: ${error.message}`);
  });
  return currentPeer;
}

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
    setConnectionStatus('ゲームのバージョンを確認しています…');
    handshakeTimeout = setTimeout(() => {
      if (channel === connection && !onlineStarted) {
        setConnectionStatus('相手と通信バージョンを確認できません。両方のページを最新版にしてください。');
      }
    }, 5000);
    send({ type: 'hello', protocol: PROTOCOL_VERSION });
  });
  connection.on('close', () => {
    if (channel === connection) {
      channel = null;
      clearTimeout(handshakeTimeout);
      handshakeTimeout = null;
      onlineStarted = false;
      syncPaused = false;
      setConnectionStatus('通信が切断されました');
    }
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
    if (message.type === 'hello') {
      if (message.protocol !== PROTOCOL_VERSION) {
        setConnectionStatus('通信相手のゲームバージョンが異なります。両方を再読み込みしてください。');
        return;
      }
      clearTimeout(handshakeTimeout);
      handshakeTimeout = null;
      if (role === 'host' && !onlineStarted) {
        startOnlineRound();
      } else if (role === 'guest' && !onlineStarted) {
        setConnectionStatus('通信バージョンを確認しました。ホストの開始を待っています…');
      }
    } else if (message.type === 'round-start' && role === 'guest') {
      beginOnlineRound(message);
    } else if (message.type === 'input') {
      receiveRemoteInput(message);
    } else if (message.type === 'resync-request' && role === 'host') {
      if (
        message.protocol !== PROTOCOL_VERSION ||
        message.epoch !== syncEpoch ||
        !Number.isInteger(message.token)
      ) {
        return;
      }
      syncPaused = true;
      pendingResyncToken = message.token;
      syncEpoch += 1;
      send({
        type: 'resync-state',
        protocol: PROTOCOL_VERSION,
        token: message.token,
        epoch: syncEpoch,
        frame: simulationFrame,
        state: cloneState(),
      });
      clearRollbackHistory();
      setConnectionStatus('通信遅延のため同期中です。ゲーム進行を一時停止しています。');
    } else if (message.type === 'resync-state' && role === 'guest') {
      acceptResyncState(message);
    } else if (
      message.type === 'resync-ack' &&
      role === 'host' &&
      syncPaused &&
      message.protocol === PROTOCOL_VERSION &&
      message.token === pendingResyncToken &&
      message.epoch === syncEpoch
    ) {
      pendingResyncToken = null;
      syncPaused = false;
      clearRollbackHistory();
      setConnectionStatus('オンライン対戦中（同期を再開しました）');
    } else if (
      message.type === 'rematch' &&
      role === 'host' &&
      message.protocol === PROTOCOL_VERSION &&
      message.epoch === syncEpoch
    ) {
      startOnlineRound();
    } else if (message.type === 'ping') {
      send({ type: 'pong', t: message.t });
    } else if (message.type === 'pong') {
      const roundTripTime = Math.round(performance.now() - message.t);
      if (!syncPaused && onlineStarted) {
        setConnectionStatus(`オンライン対戦中（往復 ${roundTripTime} ms）`);
      }
    }
  });
}

document.getElementById('createRoomBtn').addEventListener('click', () => {
  closePeer();
  role = 'host';
  updateFrameMeter();
  resetRound();
  const roomCodeInput = document.getElementById('roomCode');
  const copyButton = document.getElementById('copyRoomBtn');
  roomCodeInput.value = '';
  copyButton.disabled = true;
  setConnectionStatus('部屋を作成しています…');
  try {
    const hostPeer = createPeer();
    hostPeer.on('open', (id) => {
      if (peer === hostPeer) {
        roomCodeInput.value = id;
        copyButton.disabled = false;
        setConnectionStatus('部屋を作成しました。コードを相手に共有してください。');
      }
    });
    hostPeer.on('connection', (connection) => {
      if (channel) {
        connection.close();
        return;
      }
      setConnectionStatus('参加者の接続を待っています…');
      setupChannel(connection);
    });
  } catch (error) {
    setConnectionStatus(error.message);
  }
});

document.getElementById('copyRoomBtn').addEventListener('click', async () => {
  const roomCodeInput = document.getElementById('roomCode');
  if (!roomCodeInput.value) {
    return;
  }
  try {
    await navigator.clipboard.writeText(roomCodeInput.value);
    setConnectionStatus('部屋コードをコピーしました。');
  } catch (error) {
    roomCodeInput.select();
    const copied = document.execCommand('copy');
    setConnectionStatus(
      copied ? '部屋コードをコピーしました。' : `コピーできませんでした: ${error.message}`,
    );
  }
});

document.getElementById('joinRoomBtn').addEventListener('click', () => {
  const code = document.getElementById('joinCodeInput').value.trim();
  if (!code) {
    setConnectionStatus('参加する部屋コードを入力してください。');
    return;
  }
  closePeer();
  role = 'guest';
  updateFrameMeter();
  resetRound();
  setConnectionStatus('部屋に接続しています…');
  try {
    const guestPeer = createPeer();
    guestPeer.on('open', () => {
      if (peer === guestPeer) {
        setupChannel(guestPeer.connect(code, {
          reliable: true,
          serialization: 'json',
        }));
      }
    });
  } catch (error) {
    setConnectionStatus(error.message);
  }
});

document.getElementById('resetConnectionBtn').addEventListener('click', () => {
  closePeer();
  role = 'local';
  updateFrameMeter();
  resetRound();
  document.getElementById('roomCode').value = '';
  document.getElementById('joinCodeInput').value = '';
  document.getElementById('copyRoomBtn').disabled = true;
  setConnectionStatus('ローカル2人プレイ');
});

document.getElementById('restart').addEventListener('click', () => {
  if (role === 'guest') {
    if (!channel?.open) {
      setConnectionStatus('通信が接続されていません');
      return;
    }
    send({ type: 'rematch', protocol: PROTOCOL_VERSION, epoch: syncEpoch });
    setConnectionStatus('ホストに再戦をリクエストしました');
    return;
  }
  if (role === 'host') {
    if (!channel?.open) {
      setConnectionStatus('通信が接続されていません');
      return;
    }
    startOnlineRound();
  } else {
    resetRound();
  }
});

resetRound();
requestAnimationFrame(loop);
