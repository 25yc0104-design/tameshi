'use strict';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const keys = new Set();
const hpBars = [document.getElementById('hp1'), document.getElementById('hp2')];
const timerDisplay = document.getElementById('timer');
const resultDisplay = document.getElementById('result');

const keymap = [
  {
    left: 'KeyA',
    right: 'KeyD',
    jump: 'KeyW',
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
    left: 'ArrowLeft',
    right: 'ArrowRight',
    jump: 'ArrowUp',
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

const attackList = [
  ['weakPunch', 1],
  ['mediumPunch', 2],
  ['strongPunch', 3],
  ['weakKick', 4],
  ['mediumKick', 5],
  ['strongKick', 6],
  ['throw', 7],
];

const damageByAttack = [0, 5, 9, 14, 6, 10, 15, 12];
const reachByAttack = [0, 78, 95, 115, 88, 105, 125, 65];
const durationByAttack = [0, 17, 20, 23, 18, 21, 24, 25];
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
    attackKind: 0,
    attackId: 0,
    hitId: 0,
    stun: 0,
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
  fighter.attack = durationByAttack[kind];
  fighter.attackKind = kind;
  fighter.attackId += 1;
}

function updateGame(deltaTime) {
  if (gameOver) {
    return;
  }

  const frameScale = deltaTime / 16.667;
  const inputs = [inputFor(0), inputFor(1)];

  for (let index = 0; index < fighters.length; index += 1) {
    const fighter = fighters[index];
    const opponent = fighters[1 - index];
    const input = inputs[index];

    if (fighter.stun > 0) {
      fighter.stun = Math.max(0, fighter.stun - deltaTime);
      continue;
    }

    const speed = input.guard ? 1.4 : 2.7;
    if (input.left) fighter.x -= speed * frameScale;
    if (input.right) fighter.x += speed * frameScale;
    fighter.x = Math.max(60, Math.min(900, fighter.x));

    if (input.jump && fighter.onGround) {
      fighter.onGround = false;
      fighter.vy = -8.8;
      fighter.jumpDir = input.right ? 1 : input.left ? -1 : 0;
    }

    if (!fighter.onGround) {
      fighter.y += fighter.vy * frameScale;
      fighter.vy += 0.42 * frameScale;
      fighter.x += fighter.jumpDir * 1.4 * frameScale;
      if (fighter.y >= 335) {
        fighter.y = 335;
        fighter.vy = 0;
        fighter.onGround = true;
        fighter.jumpDir = 0;
      }
    }

    fighter.facing = opponent.x >= fighter.x ? 1 : -1;
    fighter.guard = Boolean(input.guard);

    for (const [button, kind] of attackList) {
      if (input[button] && !previousInput[index][button]) {
        startAttack(fighter, kind);
      }
    }

    if (fighter.attack > 0) {
      fighter.attack = Math.max(0, fighter.attack - frameScale);
      const throwAttack = fighter.attackKind === 7;
      const active = fighter.attack > 4 && fighter.attack < (throwAttack ? 18 : 13);
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
          opponent.facing === -fighter.facing &&
          !throwAttack;
        const damage = damageByAttack[fighter.attackKind];
        opponent.hp = Math.max(
          0,
          opponent.hp - (guarded ? Math.max(1, Math.floor(damage * 0.18)) : damage),
        );

        screenShake = Math.max(screenShake, guarded ? 3 : 8);
        if (!guarded) {
          opponent.stun = throwAttack ? 15 : 8;
          if (throwAttack) {
            opponent.x = Math.max(60, Math.min(900, opponent.x + fighter.facing * 25));
          }
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
  const { x, y, facing, guard, attack, attackKind, color, darkColor } = fighter;
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

  if (guard) {
    ctx.strokeStyle = '#63d6d2';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(x, y - 10, 30, -1.2, 1.2);
    ctx.stroke();
  }

  if (attack <= 0) {
    return;
  }
  if (attackKind >= 4 && attackKind <= 6) {
    const kickReach = attackKind === 4 ? 45 : attackKind === 5 ? 60 : 76;
    ctx.fillStyle = darkColor;
    ctx.fillRect(x + facing * 8, y + 5, facing * (kickReach - 8), 9);
    ctx.fillStyle = color;
    ctx.fillRect(x + facing * (kickReach - 3), y + 4, facing * 12, 11);
    return;
  }

  const punchReach = attackKind === 1 ? 45 : attackKind === 2 ? 60 : attackKind === 3 ? 76 : 43;
  ctx.fillStyle = attackKind === 7 ? '#63d6d2aa' : `${color}aa`;
  ctx.fillRect(x + facing * 18, y - 17, facing * punchReach, 12);
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

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate((Math.random() - 0.5) * screenShake, (Math.random() - 0.5) * screenShake);
  drawArena();
  fighters.forEach(drawFighter);
  ctx.restore();
  screenShake = Math.max(0, screenShake - 0.7);
  drawGameOver();
  updateHud();
}

function loop(now) {
  const deltaTime = Math.min(40, now - lastFrame);
  lastFrame = now;
  updateGame(deltaTime);
  draw();
  requestAnimationFrame(loop);
}

window.addEventListener('keydown', (event) => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(event.code)) {
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

document.getElementById('restart').addEventListener('click', resetRound);

resetRound();
requestAnimationFrame(loop);
