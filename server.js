const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

const WIDTH = 800;
const HEIGHT = 520;
const GRAVITY = 0.56;
const JUMP_FORCE = -11.6;
const MOVE_SPEED = 4.8;
const PLAYER_R = 14;
const MAIN_ROOM_ID = 'MAIN';
const PREVIEW_CHANNEL = 'PREVIEW_MAIN';
const MIN_PLAYERS_MAIN = 6;
const MIN_PLAYERS_PRIVATE = 4;

const PLATFORMS = [
  { x: 0, y: 480, w: 800, h: 40, solid: true },
  { x: 65, y: 375, w: 185, h: 12, solid: false },
  { x: 550, y: 375, w: 185, h: 12, solid: false },
  { x: 295, y: 285, w: 210, h: 12, solid: false },
  { x: 105, y: 190, w: 160, h: 12, solid: false },
  { x: 535, y: 190, w: 160, h: 12, solid: false }
];

const COLORS = ['#00ffff', '#ff007f', '#39ff14', '#ffcc00', '#ff5500', '#b026ff'];
const AI_STYLES = ['HUNTER', 'ACROBAT', 'CAUTIOUS', 'SPRINTER', 'SHADOW'];
const AI_NAMES = ['UNIT-01', 'UNIT-02', 'UNIT-03', 'UNIT-04', 'UNIT-05', 'UNIT-06', 'UNIT-07', 'UNIT-08'];

const rooms = new Map();

function createRoom(id, isPublic = false, hostId = null) {
  const room = {
    id,
    isPublic,
    isDemo: false,
    isSolo: false,
    hostId,
    state: 'LOBBY',
    stateTimer: 0,
    roundTime: 0,
    spawnTimer: 0,
    shardTimer: 120,
    players: new Map(),
    traps: [],
    shards: [],
    events: [],
    winner: null,
    nextTrapId: 1,
    nextShardId: 1,
    tickCount: 0,
    fillAI: true
  };
  rooms.set(id, room);
  return room;
}

const mainRoom = createRoom(MAIN_ROOM_ID, true, null);

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms.has(code));
  return code;
}

function getSpawnPoint(index) {
  const spots = [
    { x: 160, y: 450 },
    { x: 640, y: 450 },
    { x: 400, y: 255 },
    { x: 155, y: 345 },
    { x: 645, y: 345 },
    { x: 185, y: 160 },
    { x: 615, y: 160 },
    { x: 400, y: 450 }
  ];
  return spots[index % spots.length];
}

function createEntity(id, name, isAI, color, index, spectating) {
  const spawn = getSpawnPoint(index);
  const finalColor = COLORS.includes(color) ? color : COLORS[index % COLORS.length];
  return {
    id,
    name: String(name || 'PLAYER').slice(0, 12).toUpperCase(),
    isAI,
    color: finalColor,
    x: spawn.x,
    y: spawn.y,
    vx: 0,
    vy: 0,
    facing: 1,
    jumpsLeft: 2,
    onGround: false,
    coyoteTimer: 0,
    jumpBuffer: 0,
    dropTimer: 0,
    shield: false,
    shardCount: 0,
    invuln: 0,
    alive: !spectating,
    spectating,
    score: 0,
    survivalTime: 0,
    input: { left: false, right: false, jump: false, down: false },
    aiStyle: isAI ? AI_STYLES[index % AI_STYLES.length] : null,
    aiTargetX: spawn.x,
    aiDecisionTick: 0,
    aiPatrolDir: Math.random() < 0.5 ? -1 : 1,
    aiHopCooldown: 0
  };
}

function countHumans(room) {
  let count = 0;
  for (const p of room.players.values()) {
    if (!p.isAI) count++;
  }
  return count;
}

function removeAI(room) {
  for (const [id, p] of room.players.entries()) {
    if (p.isAI) room.players.delete(id);
  }
}

function startMatch(room, demoMode = false) {
  removeAI(room);
  room.isDemo = demoMode;
  room.traps = [];
  room.shards = [];
  room.events = [];
  room.winner = null;
  room.roundTime = 0;
  room.spawnTimer = 55;
  room.shardTimer = 90;

  let idx = 0;
  for (const p of room.players.values()) {
    const sp = getSpawnPoint(idx);
    p.x = sp.x;
    p.y = sp.y;
    p.vx = 0;
    p.vy = 0;
    p.jumpsLeft = 2;
    p.onGround = false;
    p.coyoteTimer = 0;
    p.jumpBuffer = 0;
    p.dropTimer = 0;
    p.shield = false;
    p.shardCount = 0;
    p.invuln = 0;
    p.alive = true;
    p.spectating = false;
    p.score = 0;
    p.survivalTime = 0;
    idx++;
  }

  const targetCount = room.isPublic
    ? MIN_PLAYERS_MAIN
    : (room.fillAI ? MIN_PLAYERS_PRIVATE : 0);

  let aiIdx = 0;
  while (room.players.size < targetCount) {
    const aiId = `ai_${room.id}_${aiIdx}`;
    const aiName = AI_NAMES[aiIdx % AI_NAMES.length];
    const aiColor = COLORS[idx % COLORS.length];
    room.players.set(aiId, createEntity(aiId, aiName, true, aiColor, idx, false));
    aiIdx++;
    idx++;
  }

  room.isSolo = !demoMode && room.players.size === 1;
  room.state = 'PLAYING';
  room.stateTimer = 0;
  spawnShard(room);
}

startMatch(mainRoom, true);

function endMatch(room, winner) {
  room.state = 'ENDED';
  room.stateTimer = room.isDemo ? 90 : 210;
  room.winner = winner
    ? { id: winner.id, name: winner.name, color: winner.color, score: winner.score, isAI: winner.isAI }
    : { id: null, name: 'DRAW', color: '#00ffff', score: 0, isAI: false };
}

function spawnShard(room) {
  if (room.shards.length >= 2) return;
  const p = PLATFORMS[Math.floor(Math.random() * PLATFORMS.length)];
  const margin = 35;
  const x = p.x + margin + Math.random() * Math.max(20, p.w - margin * 2);
  const y = p.y - 22;
  room.shards.push({ id: room.nextShardId++, x, y });
}

function spawnTrap(room) {
  const sec = room.roundTime / 60;
  const roll = Math.random();

  if (sec > 8 && roll < 0.16) {
    const ax = 180 + Math.random() * (WIDTH - 360);
    const len = 240 + Math.random() * 140;
    const maxAngle = 0.92;
    const dir = Math.random() < 0.5 ? 1 : -1;
    const startAngle = dir * maxAngle;
    room.traps.push({
      id: room.nextTrapId++,
      type: 'flail',
      ax,
      ay: 0,
      len,
      maxAngle,
      phase: dir > 0 ? Math.PI / 2 : -Math.PI / 2,
      speed: 0.042 + Math.min(0.015, sec * 0.0004),
      x: ax + Math.sin(startAngle) * len,
      y: Math.cos(startAngle) * len,
      r: 22,
      state: 'warn',
      timer: 48
    });
    return;
  }

  if (sec > 12 && roll < 0.30) {
    const laneY = [150, 245, 340, 445][Math.floor(Math.random() * 4)];
    room.traps.push({ id: room.nextTrapId++, type: 'laser', y: laneY, state: 'warn', timer: 55 });
    return;
  }

  if (sec > 5 && roll < 0.46) {
    const fromLeft = Math.random() < 0.5;
    room.traps.push({
      id: room.nextTrapId++,
      type: 'saw',
      x: fromLeft ? 28 : WIDTH - 28,
      y: 45,
      vx: (fromLeft ? 1 : -1) * (3.2 + Math.random() * 1.8),
      vy: 1.5,
      r: 17,
      state: 'active',
      timer: 360
    });
    return;
  }

  if (roll < 0.74) {
    const fromLeft = Math.random() < 0.5;
    const yOptions = [165, 260, 350, 455, 110 + Math.random() * 340];
    const y = yOptions[Math.floor(Math.random() * yOptions.length)];
    const speed = 7.5 + Math.min(5, sec * 0.12);
    room.traps.push({
      id: room.nextTrapId++,
      type: 'dart',
      x: fromLeft ? 14 : WIDTH - 14,
      y,
      vx: fromLeft ? speed : -speed,
      vy: 0,
      dir: fromLeft ? 1 : -1,
      state: 'warn',
      timer: 42
    });
  } else {
    const x = 40 + Math.random() * (WIDTH - 80);
    room.traps.push({ id: room.nextTrapId++, type: 'spike', x, y: 18, vx: 0, vy: 0, state: 'warn', timer: 42 });
  }
}

function updateAI(room, bot) {
  bot.input.left = false;
  bot.input.right = false;
  bot.input.down = false;
  if (bot.aiHopCooldown > 0) bot.aiHopCooldown--;

  const style = bot.aiStyle || 'HUNTER';
  const senseRange = style === 'CAUTIOUS' ? 300 : (style === 'SPRINTER' ? 190 : 240);
  const spikeMargin = style === 'CAUTIOUS' ? 75 : 52;
  const orbRange = style === 'CAUTIOUS' ? 150 : 115;

  let dangerLeft = 0;
  let dangerRight = 0;
  let needJump = false;
  let needDrop = false;

  for (const t of room.traps) {
    if (t.type === 'dart') {
      const dy = Math.abs(t.y - bot.y);
      const dx = t.x - bot.x;
      const approaching = (t.dir === 1 && dx < 0 && dx > -senseRange) || (t.dir === -1 && dx > 0 && dx < senseRange);
      if (dy < 36 && (approaching || t.state === 'warn')) {
        if (bot.y > 110) needJump = true;
      }
    } else if (t.type === 'spike') {
      const dx = t.x - bot.x;
      if (Math.abs(dx) < spikeMargin && t.y < bot.y + 18) {
        if (dx >= 0) dangerRight += 4;
        else dangerLeft += 4;
      }
    } else if (t.type === 'saw' || t.type === 'flail') {
      const dx = t.x - bot.x;
      const dy = t.y - bot.y;
      if (Math.hypot(dx, dy) < orbRange) {
        if (dx >= 0) dangerRight += 5;
        else dangerLeft += 5;
        if (dy > -25 && dy < 50) needJump = true;
      }
    } else if (t.type === 'laser') {
      if (Math.abs(t.y - bot.y) < 38) {
        if (bot.y <= t.y) {
          needJump = true;
        } else {
          needDrop = true;
        }
      }
    }
  }

  if (dangerRight > dangerLeft) {
    bot.input.left = true;
  } else if (dangerLeft > dangerRight) {
    bot.input.right = true;
  } else {
    bot.aiDecisionTick--;

    if (style === 'HUNTER') {
      let targetShard = null;
      let bestDist = Infinity;
      for (const s of room.shards) {
        const d = Math.hypot(s.x - bot.x, s.y - bot.y);
        if (d < bestDist) { bestDist = d; targetShard = s; }
      }
      if (targetShard) {
        bot.aiTargetX = targetShard.x;
        if (targetShard.y < bot.y - 40 && Math.abs(targetShard.x - bot.x) < 150 && bot.aiHopCooldown <= 0) {
          needJump = true;
          bot.aiHopCooldown = 18;
        } else if (targetShard.y > bot.y + 55 && Math.abs(targetShard.x - bot.x) < 120) {
          needDrop = true;
        }
      } else if (bot.aiDecisionTick <= 0) {
        bot.aiDecisionTick = 25;
        bot.aiTargetX = 120 + Math.random() * (WIDTH - 240);
      }
      if (bot.aiTargetX < bot.x - 14) bot.input.left = true;
      else if (bot.aiTargetX > bot.x + 14) bot.input.right = true;

    } else if (style === 'ACROBAT') {
      if (bot.aiDecisionTick <= 0) {
        bot.aiDecisionTick = 45 + Math.floor(Math.random() * 35);
        const highSpots = [185, 400, 615];
        bot.aiTargetX = highSpots[Math.floor(Math.random() * highSpots.length)] + (Math.random() - 0.5) * 80;
      }
      if (bot.aiTargetX < bot.x - 20) bot.input.left = true;
      else if (bot.aiTargetX > bot.x + 20) bot.input.right = true;
      if (bot.y > 270 && bot.aiHopCooldown <= 0) {
        needJump = true;
        bot.aiHopCooldown = 26;
      } else if (bot.onGround && Math.random() < 0.04) {
        needJump = true;
      }

    } else if (style === 'CAUTIOUS') {
      if (bot.aiDecisionTick <= 0) {
        bot.aiDecisionTick = 50 + Math.floor(Math.random() * 40);
        bot.aiTargetX = WIDTH * 0.5 + (Math.random() - 0.5) * 160;
      }
      if (bot.aiTargetX < bot.x - 28) bot.input.left = true;
      else if (bot.aiTargetX > bot.x + 28) bot.input.right = true;

    } else if (style === 'SPRINTER') {
      if (bot.x < 95) bot.aiPatrolDir = 1;
      else if (bot.x > WIDTH - 95) bot.aiPatrolDir = -1;
      else if (bot.aiDecisionTick <= 0) {
        bot.aiDecisionTick = 30 + Math.floor(Math.random() * 35);
        if (Math.random() < 0.35) bot.aiPatrolDir *= -1;
      }
      if (bot.aiPatrolDir < 0) bot.input.left = true;
      else bot.input.right = true;
      if (bot.onGround && Math.random() < 0.025) needJump = true;

    } else if (style === 'SHADOW') {
      let leader = null;
      for (const other of room.players.values()) {
        if (other.id === bot.id || !other.alive || other.spectating) continue;
        if (!other.isAI) { leader = other; break; }
        if (!leader || other.score > leader.score) leader = other;
      }
      if (leader) {
        const desiredX = leader.x + (bot.x < leader.x ? -55 : 55);
        if (desiredX < bot.x - 16) bot.input.left = true;
        else if (desiredX > bot.x + 16) bot.input.right = true;
        if (leader.y < bot.y - 60 && bot.aiHopCooldown <= 0) {
          needJump = true;
          bot.aiHopCooldown = 22;
        } else if (leader.y > bot.y + 60) {
          needDrop = true;
        }
      }
    }
  }

  if (bot.x < 45) { bot.input.left = false; bot.input.right = true; }
  else if (bot.x > WIDTH - 45) { bot.input.right = false; bot.input.left = true; }

  if (needDrop) bot.input.down = true;
  if (needJump && bot.vy > -3.5) {
    bot.jumpBuffer = 4;
  }
}

function updatePlayerPhysics(room, p) {
  if (p.invuln > 0) p.invuln--;
  if (p.coyoteTimer > 0) p.coyoteTimer--;
  if (p.jumpBuffer > 0) p.jumpBuffer--;
  if (p.dropTimer > 0) p.dropTimer--;

  if (p.input.left && !p.input.right) {
    p.vx = -MOVE_SPEED;
    p.facing = -1;
  } else if (p.input.right && !p.input.left) {
    p.vx = MOVE_SPEED;
    p.facing = 1;
  } else {
    p.vx *= 0.72;
    if (Math.abs(p.vx) < 0.2) p.vx = 0;
  }

  if (p.input.down && p.onGround && p.y < 460) {
    p.dropTimer = 12;
    p.onGround = false;
    p.coyoteTimer = 0;
    p.y += 4;
  }

  if (p.jumpBuffer > 0) {
    if (p.coyoteTimer > 0) {
      p.vy = JUMP_FORCE;
      p.jumpsLeft = 1;
      p.coyoteTimer = 0;
      p.jumpBuffer = 0;
      p.onGround = false;
      if (!p.isAI) room.events.push({ type: 'jump', id: p.id, dbl: false });
    } else if (p.jumpsLeft > 0) {
      p.vy = JUMP_FORCE * 0.95;
      p.jumpsLeft--;
      p.jumpBuffer = 0;
      p.onGround = false;
      if (!p.isAI) room.events.push({ type: 'jump', id: p.id, dbl: true });
    }
  }

  const prevBottom = p.y + PLAYER_R;
  p.vy = Math.min(13, p.vy + GRAVITY);
  p.x += p.vx;
  p.y += p.vy;

  if (p.x < PLAYER_R) p.x = PLAYER_R;
  if (p.x > WIDTH - PLAYER_R) p.x = WIDTH - PLAYER_R;
  if (p.y < PLAYER_R) {
    p.y = PLAYER_R;
    if (p.vy < 0) p.vy = 0;
  }

  p.onGround = false;
  for (const plat of PLATFORMS) {
    if (!plat.solid && p.dropTimer > 0) continue;
    const withinX = p.x + PLAYER_R * 0.75 > plat.x && p.x - PLAYER_R * 0.75 < plat.x + plat.w;
    if (withinX && p.vy >= 0) {
      if (prevBottom <= plat.y + 8 && p.y + PLAYER_R >= plat.y) {
        p.y = plat.y - PLAYER_R;
        p.vy = 0;
        p.onGround = true;
        p.jumpsLeft = 2;
        p.coyoteTimer = 6;
      }
    }
  }
}

function checkTrapCollision(p, t) {
  if (t.state !== 'active') return false;
  if (t.type === 'dart') return Math.abs(p.x - t.x) < PLAYER_R + 14 && Math.abs(p.y - t.y) < PLAYER_R + 5;
  if (t.type === 'spike') return Math.hypot(p.x - t.x, p.y - t.y) < PLAYER_R + 11;
  if (t.type === 'saw' || t.type === 'flail') return Math.hypot(p.x - t.x, p.y - t.y) < PLAYER_R + t.r - 3;
  if (t.type === 'laser') return Math.abs(p.y - t.y) < PLAYER_R + 8;
  return false;
}

function tickRoom(room) {
  room.tickCount++;
  const humans = countHumans(room);

  if (room.state === 'LOBBY') {
    if (room.isPublic) {
      if (humans > 0) {
        room.state = 'COUNTDOWN';
        room.stateTimer = 180;
      } else {
        startMatch(room, true);
      }
    }
  } else if (room.state === 'COUNTDOWN') {
    if (humans === 0) {
      if (room.isPublic) startMatch(room, true);
      else { room.state = 'LOBBY'; room.stateTimer = 0; removeAI(room); }
    } else {
      room.stateTimer--;
      if (room.stateTimer <= 0) startMatch(room, false);
    }
  } else if (room.state === 'PLAYING') {
    room.roundTime++;
    room.spawnTimer--;
    if (room.spawnTimer <= 0) {
      spawnTrap(room);
      const difficulty = Math.min(34, Math.floor(room.roundTime / 150) * 3);
      room.spawnTimer = Math.max(14, 48 - difficulty);
    }

    room.shardTimer--;
    if (room.shardTimer <= 0) {
      spawnShard(room);
      room.shardTimer = 210;
    }

    for (let i = room.traps.length - 1; i >= 0; i--) {
      const t = room.traps[i];
      if (t.type === 'dart') {
        if (t.state === 'warn') { if (--t.timer <= 0) t.state = 'active'; }
        else { t.x += t.vx; if (t.x < -40 || t.x > WIDTH + 40) room.traps.splice(i, 1); }
      } else if (t.type === 'spike') {
        if (t.state === 'warn') { if (--t.timer <= 0) t.state = 'active'; }
        else { t.vy = Math.min(12, t.vy + 0.45); t.y += t.vy; if (t.y > 482) room.traps.splice(i, 1); }
      } else if (t.type === 'saw') {
        t.vy = Math.min(10, t.vy + 0.35);
        t.x += t.vx; t.y += t.vy;
        if (t.x < t.r || t.x > WIDTH - t.r) { t.vx *= -1; t.x = Math.max(t.r, Math.min(WIDTH - t.r, t.x)); }
        if (t.y > 480 - t.r) { t.y = 480 - t.r; t.vy = -10.5; }
        if (--t.timer <= 0) room.traps.splice(i, 1);
      } else if (t.type === 'flail') {
        t.timer--;
        if (t.state === 'warn') {
          if (t.timer <= 0) { t.state = 'active'; t.timer = 230; }
        } else {
          t.phase += t.speed;
          const angle = Math.sin(t.phase) * t.maxAngle;
          t.x = t.ax + Math.sin(angle) * t.len;
          t.y = t.ay + Math.cos(angle) * t.len;
          if (t.timer <= 0) room.traps.splice(i, 1);
        }
      } else if (t.type === 'laser') {
        t.timer--;
        if (t.state === 'warn' && t.timer <= 0) {
          t.state = 'active';
          t.timer = 28;
          room.events.push({ type: 'laser' });
        } else if (t.state === 'active' && t.timer <= 0) {
          room.traps.splice(i, 1);
        }
      }
    }

    const prevAlive = [];
    const aliveList = [];
    for (const p of room.players.values()) {
      if (!p.alive || p.spectating) continue;
      prevAlive.push(p);
      if (p.isAI) updateAI(room, p);
      updatePlayerPhysics(room, p);
      p.survivalTime++;

      for (let c = room.shards.length - 1; c >= 0; c--) {
        const shard = room.shards[c];
        if (Math.hypot(p.x - shard.x, p.y - shard.y) < PLAYER_R + 14) {
          p.score += 10;
          p.shardCount++;
          let gotShield = false;
          if (p.shardCount >= 3 && !p.shield) {
            p.shield = true;
            p.shardCount = 0;
            gotShield = true;
          }
          room.events.push({ type: 'shard', x: shard.x, y: shard.y, color: gotShield ? '#00ffff' : '#ffcc00', shield: gotShield });
          room.shards.splice(c, 1);
        }
      }

      let hit = false;
      if (p.invuln <= 0) {
        for (const t of room.traps) {
          if (checkTrapCollision(p, t)) { hit = true; break; }
        }
      }

      if (hit) {
        if (p.shield) {
          p.shield = false;
          p.invuln = 45;
          room.events.push({ type: 'shieldBreak', x: p.x, y: p.y, color: '#00ffff' });
          aliveList.push(p);
        } else {
          p.alive = false;
          room.events.push({ type: 'death', x: p.x, y: p.y, color: p.color, name: p.name });
        }
      } else {
        aliveList.push(p);
      }
    }

    if (humans === 0 && !room.isDemo) {
      if (room.isPublic) room.isDemo = true;
      else { room.state = 'LOBBY'; removeAI(room); room.traps = []; }
    } else if (room.isSolo) {
      if (aliveList.length === 0) endMatch(room, prevAlive[0] || null);
    } else if (aliveList.length <= 1) {
      let winner = aliveList[0] || null;
      if (!winner && prevAlive.length > 0) {
        prevAlive.sort((a, b) => b.score - a.score);
        if (prevAlive.length === 1 || prevAlive[0].score > prevAlive[1].score) {
          winner = prevAlive[0];
        }
      }
      endMatch(room, winner);
    }
  } else if (room.state === 'ENDED') {
    room.stateTimer--;
    if (room.stateTimer <= 0) {
      removeAI(room);
      room.traps = [];
      room.shards = [];
      if (room.isPublic) {
        if (humans > 0) {
          room.isDemo = false;
          room.state = 'COUNTDOWN';
          room.stateTimer = 180;
        } else {
          startMatch(room, true);
        }
      } else {
        room.state = 'LOBBY';
        for (const p of room.players.values()) {
          p.spectating = false;
          p.alive = true;
        }
      }
    }
  }

  const shouldBroadcast = room.isPublic || humans > 0;
  if (room.tickCount % 2 === 0 && shouldBroadcast) {
    const payload = {
      roomId: room.id,
      isPublic: room.isPublic,
      isDemo: room.isDemo,
      hostId: room.hostId,
      fillAI: room.fillAI,
      humanCount: humans,
      botCount: room.players.size - humans,
      state: room.state,
      countdown: Math.ceil(room.stateTimer / 60),
      roundSec: Math.floor(room.roundTime / 60),
      winner: room.winner,
      players: Array.from(room.players.values()).map(p => ({
        id: p.id,
        name: p.name,
        isAI: p.isAI,
        color: p.color,
        x: Math.round(p.x),
        y: Math.round(p.y),
        vx: Number(p.vx.toFixed(1)),
        vy: Number(p.vy.toFixed(1)),
        facing: p.facing,
        shield: p.shield,
        invuln: p.invuln > 0,
        alive: p.alive,
        spectating: p.spectating,
        score: p.score
      })),
      traps: room.traps,
      shards: room.shards,
      events: room.events
    };

    if (room.isPublic) io.to(room.id).to(PREVIEW_CHANNEL).emit('state', payload);
    else io.to(room.id).emit('state', payload);
    room.events = [];
  }
}

setInterval(() => {
  for (const room of rooms.values()) tickRoom(room);
}, 1000 / 60);

function leaveCurrentRoom(socket, returnToPreview = true) {
  const roomId = socket.data.roomId;
  if (roomId) {
    const room = rooms.get(roomId);
    socket.leave(roomId);
    socket.data.roomId = null;
    if (room) {
      room.players.delete(socket.id);
      if (!room.isPublic) {
        const remainingHumans = Array.from(room.players.values()).filter(p => !p.isAI);
        if (remainingHumans.length === 0) rooms.delete(roomId);
        else if (room.hostId === socket.id) room.hostId = remainingHumans[0].id;
      }
    }
  }
  if (returnToPreview) socket.join(PREVIEW_CHANNEL);
}

io.on('connection', (socket) => {
  socket.join(PREVIEW_CHANNEL);
  socket.emit('init_preview', { platforms: PLATFORMS });

  socket.on('join_public', ({ name, color }) => {
    leaveCurrentRoom(socket, false);
    socket.leave(PREVIEW_CHANNEL);
    const room = rooms.get(MAIN_ROOM_ID);
    const spectating = room.state === 'PLAYING' || room.state === 'ENDED';
    const player = createEntity(socket.id, name, false, color, room.players.size, spectating);
    room.players.set(socket.id, player);
    socket.join(MAIN_ROOM_ID);
    socket.data.roomId = MAIN_ROOM_ID;
    socket.emit('joined', { roomId: MAIN_ROOM_ID, isPublic: true, playerId: socket.id, platforms: PLATFORMS });
  });

  socket.on('create_private', ({ name, color }) => {
    leaveCurrentRoom(socket, false);
    socket.leave(PREVIEW_CHANNEL);
    const code = generateRoomCode();
    const room = createRoom(code, false, socket.id);
    const player = createEntity(socket.id, name, false, color, 0, false);
    room.players.set(socket.id, player);
    socket.join(code);
    socket.data.roomId = code;
    socket.emit('joined', { roomId: code, isPublic: false, playerId: socket.id, platforms: PLATFORMS });
  });

  socket.on('join_private', ({ name, color, code }) => {
    const cleanCode = String(code || '').trim().toUpperCase();
    const room = rooms.get(cleanCode);
    if (!room || room.isPublic) {
      socket.emit('error_msg', 'ROOM NOT FOUND');
      return;
    }
    leaveCurrentRoom(socket, false);
    socket.leave(PREVIEW_CHANNEL);
    const spectating = room.state === 'PLAYING' || room.state === 'ENDED';
    const player = createEntity(socket.id, name, false, color, room.players.size, spectating);
    room.players.set(socket.id, player);
    socket.join(cleanCode);
    socket.data.roomId = cleanCode;
    socket.emit('joined', { roomId: cleanCode, isPublic: false, playerId: socket.id, platforms: PLATFORMS });
  });

  socket.on('toggle_ai', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.isPublic || room.hostId !== socket.id || room.state !== 'LOBBY') return;
    room.fillAI = !room.fillAI;
  });

  socket.on('start_private', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.isPublic || room.hostId !== socket.id || room.state !== 'LOBBY') return;
    startMatch(room, false);
  });

  socket.on('leave_room', () => leaveCurrentRoom(socket, true));

  socket.on('input', (data) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p || !p.alive || p.spectating) return;
    p.input.left = Boolean(data.left);
    p.input.right = Boolean(data.right);
    p.input.down = Boolean(data.down);
    if (data.jump && !p.input.jump) p.jumpBuffer = 6;
    p.input.jump = Boolean(data.jump);
  });

  socket.on('disconnect', () => leaveCurrentRoom(socket, false));
});

server.listen(PORT, () => {
  console.log(`PULSE.io server running on http://localhost:${PORT}`);
});