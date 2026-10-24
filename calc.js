/* Расчёт смен для электровелосипеда.

   Модель: заряд тратится и набирается равномерно.
   - 1 час езды тратит 100 / cap процентов;
   - 1 час зарядки даёт 100 / charge процентов;
   - в конце каждой смены должен остаться запас reserve %.
   Внутри все времена и длительности — в минутах. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ShiftCalc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var STEP = 5;        // округляем до 5 минут
  var MIN_SHIFT = 45;  // самая короткая осмысленная смена, мин
  var MIN_GAIN = 30;   // вторая смена должна дать минимум столько лишней работы, мин
  var SLACK_NOTE = 30; // про лишнее время в окне пишем, только если его не меньше, мин
  var SIMILAR = 15;    // варианты, отличающиеся меньше чем на это, считаем одинаковыми, мин

  // полный запас хода 6 ч, реально ездим 5 ч (остаётся ~17%), полная зарядка 5,5 ч
  var DEFAULTS = { cap: 6, reserve: 100 / 6, charge: 5.5, soc0: 100, shortPct: 65, slack: 'break' };

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function num(v, d) {
    var n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(',', '.'));
    return isFinite(n) ? n : d;
  }
  function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
  function floorStep(x) { return Math.floor(x / STEP + 1e-9) * STEP; }
  function ceilStep(x) { return Math.ceil(x / STEP - 1e-9) * STEP; }

  function fmtDur(m) {
    m = Math.round(m);
    var h = Math.floor(m / 60), mm = m % 60;
    if (h && mm) return h + ' ч ' + mm + ' мин';
    if (h) return h + ' ч';
    return mm + ' мин';
  }
  function fmtTime(t) {
    var m = ((Math.round(t) % 1440) + 1440) % 1440;
    return pad(Math.floor(m / 60)) + ':' + pad(m % 60);
  }
  function dayShift(t) { return Math.floor(Math.round(t) / 1440); }

  function normalize(p) {
    p = p || {};
    var d = DEFAULTS;
    return {
      cap: clamp(num(p.cap, d.cap), 0.5, 24),
      reserve: clamp(num(p.reserve, d.reserve), 0, 60),
      charge: clamp(num(p.charge, d.charge), 0.25, 48),
      soc0: clamp(num(p.soc0, d.soc0), 1, 100),
      shortPct: clamp(num(p.shortPct, d.shortPct), 20, 100),
      slack: ['break', 'start', 'end'].indexOf(p.slack) >= 0 ? p.slack : d.slack
    };
  }

  function compute(startMin, endMin, params) {
    var p = normalize(params);
    if (!isFinite(startMin) || !isFinite(endMin)) return { error: 'Укажите время начала и конца.' };
    if (startMin === endMin) return { error: 'Начало и конец совпадают.' };

    var S = startMin;
    var T = endMin - startMin;
    if (T < 0) T += 1440;
    if (T < 30) return { error: 'Окно слишком короткое — меньше 30 минут.' };

    var capMin = p.cap * 60, chargeMin = p.charge * 60;
    var r = 100 / capMin;          // % заряда за минуту езды
    var g = 100 / chargeMin;       // % заряда за минуту зарядки
    var k = chargeMin / capMin;    // минут зарядки на минуту езды
    var U0 = (p.soc0 - p.reserve) / r;   // сколько можно проехать с заряда на старте
    var U = (100 - p.reserve) / r;       // сколько можно проехать с полной батареи
    if (U0 < MIN_SHIFT) {
      return { error: 'При таком заряде на старте хватит меньше чем на ' + MIN_SHIFT + ' минут езды.' };
    }

    // Зарядка, нужная между сменами a и c (мин), чтобы вторая закончилась с запасом reserve.
    function breakFor(a, c) { return Math.max(0, a + c - U0) * k; }

    function free(o1, o2) {
      return { type: 'free', start: S + o1, end: S + o2, dur: o2 - o1 };
    }

    function fits(a, c) {
      return a <= U0 + 1e-9 && c <= U + 1e-9 && a + ceilStep(breakFor(a, c)) + c <= T;
    }

    function twoShift(kind, a, c, grow) {
      a = floorStep(a);
      c = floorStep(c);
      if (grow) {
        // округление вниз съедает до 10 минут — добираем шагами по 5 минут
        for (;;) {
          if (c <= a && fits(a, c + STEP)) c += STEP;
          else if (fits(a + STEP, c)) a += STEP;
          else if (fits(a, c + STEP)) c += STEP;
          else break;
        }
      }
      var b = ceilStep(breakFor(a, c));
      while (a + b + c > T && (a > STEP || c > STEP)) {
        if (c >= a) c -= STEP; else a -= STEP;
        b = ceilStep(breakFor(a, c));
      }
      var slack = T - a - b - c;
      var brk = p.slack === 'break' ? b + slack : b;
      var aStart = p.slack === 'start' ? slack : 0;
      var aEnd = aStart + a;
      var kEnd = aEnd + brk;
      var cEnd = kEnd + c;

      var socA = p.soc0 - r * a;
      var socB = Math.min(100, socA + g * brk);
      var socEnd = socB - r * c;

      var items = [];
      if (p.slack === 'start' && slack > 0) items.push(free(0, slack));
      items.push({ type: 'work', start: S + aStart, end: S + aEnd, dur: a, from: p.soc0, to: socA });
      items.push({ type: 'charge', start: S + aEnd, end: S + kEnd, dur: brk, needed: b, from: socA, to: socB });
      items.push({ type: 'work', start: S + kEnd, end: S + cEnd, dur: c, from: socB, to: socEnd });
      if (p.slack === 'end' && slack > 0) items.push(free(cEnd, T));

      return { kind: kind, items: items, work: a + c, a: a, c: c, brk: brk, needed: b, slack: slack, socEnd: socEnd };
    }

    function oneShift() {
      var L = T <= U0 ? T : floorStep(U0);
      var slack = T - L;
      var off = p.slack === 'start' ? slack : 0;
      var items = [];
      if (off > 0) items.push(free(0, off));
      items.push({ type: 'work', start: S + off, end: S + off + L, dur: L, from: p.soc0, to: p.soc0 - r * L });
      if (slack - off > 0) items.push(free(off + L, T));
      return { kind: 'one', items: items, work: L, a: L, c: 0, brk: 0, needed: 0, slack: slack, socEnd: p.soc0 - r * L };
    }

    // Максимум работы за две смены: ограничен окном и батареей.
    var Wmax = Math.min(U0 + U, (T + U0 * k) / (1 + k));
    var twoOk = Wmax - U0 >= MIN_GAIN;
    var one = oneShift();
    var variants = [];

    if (twoOk) {
      var aLo = Math.max(MIN_SHIFT, Wmax - U);
      var aHi = Math.min(U0, Wmax - MIN_SHIFT);
      var aMid = Math.min(aHi, Math.max(aLo, Wmax / 2));
      var candidates = [twoShift('max', aMid, Wmax - aMid, true)];

      // Больше в начале: первая смена на максимум, вторая короче.
      var aF = Math.min(U0, Wmax - MIN_SHIFT);
      var cF = Math.max(MIN_SHIFT, Math.min(Wmax - aF, aF * p.shortPct / 100));
      candidates.push(twoShift('front', aF, cF));

      // Больше в конце: первая смена короче, вторая на максимум.
      var cB = Math.min(U, Wmax - MIN_SHIFT);
      var aB = Math.max(MIN_SHIFT, Math.min(Wmax - cB, cB * p.shortPct / 100, U0));
      candidates.push(twoShift('back', aB, cB));

      candidates.forEach(function (v) {
        if (v.work - one.work < MIN_GAIN) return;
        var dup = variants.some(function (w) {
          return Math.abs(w.a - v.a) <= SIMILAR && Math.abs(w.c - v.c) <= SIMILAR;
        });
        if (!dup) variants.push(v);
      });
    }
    variants.push(one);

    var best = 0;
    variants.forEach(function (v) { if (v.work > best) best = v.work; });

    var notes = [];
    if (T <= U0) {
      notes.push('Заряда на старте хватает на всё окно — достаточно одной смены.');
    } else if (!twoOk) {
      notes.push('Вторая смена добавила бы меньше ' + MIN_GAIN + ' минут работы (зарядка слишком долгая), поэтому хватит одной.');
    } else {
      var mx = variants[0];
      if (mx.kind === 'max' && mx.slack >= SLACK_NOTE) {
        notes.push('Окно длиннее, чем нужно для двух полных смен: лишних ' + fmtDur(mx.slack) + '.');
      }
    }

    return {
      ok: true, S: S, T: T, p: p, r: r, g: g, k: k, U0: U0, U: U,
      variants: variants, bestWork: best, notes: notes
    };
  }

  return {
    compute: compute, normalize: normalize, DEFAULTS: DEFAULTS,
    fmtDur: fmtDur, fmtTime: fmtTime, dayShift: dayShift, floorStep: floorStep
  };
});
