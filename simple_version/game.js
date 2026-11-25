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
let remoteInput = [{}, {}];
let lastInputSent = 0;
let lastStateSent = 0;
let pingAt = 0;
const snapshotBuffer = [];
const snapshotDelay = 50;
const maxSnapshots = 30;

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
  snapshotBuffer.length = 0;
  previousInput = [{}, {}];
  remoteInput = [{}, {}];
  remaining = 99;
  gameOver = false;
  screenShake = 0;
  resultDisplay.textContent = '';
  updateHud();
}

function inputFor(player) {
  const isLocalPlayer =
    role === 'local' ||
    (role === 'host' && player === 0) ||
    (role === 'guest' && player === 1);
  if (!isLocalPlayer) {
    return remoteInput[player] || {};
  }
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

function updateGame(deltaTime) {
  if (gameOver || role === 'guest' || (role === 'host' && !channel?.open)) {
    return;
  }

  const frameScale = deltaTime / 16.667;
  const inputs = [inputFor(0), inputFor(1)];

  for (let index = 0; index < fighters.length; index += 1) {
    const fighter = fighters[index];
    const opponent = fighters[1 - index];
    const input = inputs[index];
    fighter.guardFlash = Math.max(0, fighter.guardFlash - frameScale);

    if (fighter.stun > 0) {
      fighter.stun = Math.max(0, fighter.stun - deltaTime);
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

  remaining = Math.max(0, remaining - deltaTime / 1000);
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

function addSnapshot(snapshot) {
  const receivedAt = performance.now();
  const snapshotFighters = snapshot.fighters.map((fighter) => ({ ...fighter }));
  snapshotBuffer.push({ receivedAt, fighters: snapshotFighters });
  if (snapshotBuffer.length > maxSnapshots) {
    snapshotBuffer.shift();
  }
  fighters = snapshotFighters;
  remaining = snapshot.remaining;
  gameOver = snapshot.gameOver;
}

function getRenderedFighters(now) {
  if (role !== 'guest' || snapshotBuffer.length === 0) {
    return fighters;
  }

  const targetTime = now - snapshotDelay;
  let before = snapshotBuffer[0];
  let after = null;
  for (const snapshot of snapshotBuffer) {
    if (snapshot.receivedAt <= targetTime) {
      before = snapshot;
    }
    if (snapshot.receivedAt >= targetTime) {
      after = snapshot;
      break;
    }
  }

  while (snapshotBuffer.length > 2 && snapshotBuffer[1].receivedAt <= targetTime) {
    snapshotBuffer.shift();
  }

  if (!after || after === before || after.receivedAt <= before.receivedAt) {
    return before.fighters;
  }

  const progress = Math.max(
    0,
    Math.min(1, (targetTime - before.receivedAt) / (after.receivedAt - before.receivedAt)),
  );
  return before.fighters.map((fighter, index) => {
    const nextFighter = after.fighters[index];
    return {
      ...fighter,
      x: fighter.x + (nextFighter.x - fighter.x) * progress,
      y: fighter.y + (nextFighter.y - fighter.y) * progress,
    };
  });
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

function draw(now) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate((Math.random() - 0.5) * screenShake, (Math.random() - 0.5) * screenShake);
  drawArena();
  getRenderedFighters(now).forEach(drawFighter);
  ctx.restore();
  screenShake = Math.max(0, screenShake - 0.7);
  drawGameOver();
  updateHud();
  updateFrameMeter();
}

function loop(now) {
  const deltaTime = Math.min(40, now - lastFrame);
  lastFrame = now;
  if (!gameOver) {
    updateGame(deltaTime);
    if (role === 'guest' && now - lastInputSent > 25) {
      send({ type: 'input', input: inputFor(1) });
      lastInputSent = now;
    }
    if (role === 'host' && now - lastStateSent >= 1000 / 60) {
      send({ type: 'state', fighters, remaining, gameOver });
      lastStateSent = now;
    }
    if (channel?.open && now - pingAt > 700) {
      send({ type: 'ping', t: now });
      pingAt = now;
    }
  }
  draw(now);
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
    setConnectionStatus(`オンライン接続中（${role === 'host' ? 'ホスト' : '参加者'}）`);
    if (role === 'host') {
      send({ type: 'state', fighters, remaining, gameOver });
    }
  });
  connection.on('close', () => {
    if (channel === connection) {
      channel = null;
      snapshotBuffer.length = 0;
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
    if (message.type === 'input' && role === 'host' && message.input) {
      remoteInput[1] = message.input;
    } else if (message.type === 'state' && role === 'guest') {
      if (!Array.isArray(message.fighters) || message.fighters.length !== 2) {
        return;
      }
      if (message.rematch) {
        snapshotBuffer.length = 0;
      }
      addSnapshot(message);
      if (message.rematch) {
        setConnectionStatus('オンライン接続中（参加者）');
      }
    } else if (message.type === 'rematch' && role === 'host') {
      resetRound();
      send({ type: 'state', fighters, remaining, gameOver, rematch: true });
    } else if (message.type === 'ping') {
      send({ type: 'pong', t: message.t });
    } else if (message.type === 'pong') {
      const roundTripTime = Math.round(performance.now() - message.t);
      setConnectionStatus(`オンライン接続中（往復 ${roundTripTime} ms）`);
    }
  });
}

document.getElementById('createRoomBtn').addEventListener('click', () => {
  closePeer();
  role = 'host';
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
    send({ type: 'rematch' });
    setConnectionStatus('ホストに再戦をリクエストしました');
    return;
  }
  resetRound();
  if (role === 'host') {
    send({ type: 'state', fighters, remaining, gameOver, rematch: true });
  }
});

resetRound();
requestAnimationFrame(loop);
