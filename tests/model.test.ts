import { describe, expect, it } from 'vitest';
import { FAN_MODELS, fanFlow, flowTotals, setSpeed } from '../src/model/fans';
import { defaultLayout } from '../src/model/machine';
import { parseLayout, resolveFan, serialiseLayout } from '../src/model/layout';

describe('fans', () => {
  it('halves the flow at half the rated speed', () => {
    const m = FAN_MODELS.p12;
    expect(fanFlow(m, m.ratedRpm / 2)).toBeCloseTo(fanFlow(m, m.ratedRpm) / 2);
    expect(fanFlow(m, 0)).toBe(0);
  });
  it('totals the default layout as positive pressure', () => {
    const t = flowTotals(defaultLayout());
    expect(t.intake).toBeGreaterThan(t.exhaust);
    expect(t.balance).toBeCloseTo(t.intake - t.exhaust);
  });
});

describe('speed groups', () => {
  const rpm = (l: ReturnType<typeof defaultLayout>, id: string) => l.fans.find((f) => f.id === id)!.rpm;
  it('moves the whole group and nothing else', () => {
    const l = defaultLayout();
    setSpeed(l, 'front-1', 600);
    expect([rpm(l, 'front-2'), rpm(l, 'front-3'), rpm(l, 'rear')]).toEqual([600, 600, 1200]);
  });
  it('moves one fan when it has no group', () => {
    const l = defaultLayout();
    delete l.fans[0].group;
    setSpeed(l, l.fans[0].id, 600);
    expect(rpm(l, 'front-2')).toBe(1000);
  });
});

describe('layout', () => {
  it('has the fans of My PC', () => {
    const l = defaultLayout();
    const count = (role: string) => l.fans.filter((f) => f.role === role).length;
    expect([count('case'), count('cpu'), count('gpu')]).toEqual([8, 2, 2]);
  });
  it('turns CPU fans with the cooler', () => {
    const l = defaultLayout();
    const fan = l.fans.find((f) => f.role === 'cpu')!;
    expect(resolveFan(fan, { rotation: 0 }).dir).toEqual([-1, 0, 0]);
    expect(resolveFan(fan, { rotation: 90 }).dir).toEqual([0, 1, 0]);
  });
  it('round-trips through JSON', () => {
    const l = defaultLayout();
    expect(parseLayout(serialiseLayout(l))).toEqual(l);
  });
  it('gives layouts saved without a vent loss the default one', () => {
    const old = JSON.parse(serialiseLayout(defaultLayout()));
    delete old.ventLoss;
    expect(parseLayout(JSON.stringify(old)).ventLoss).toBe(defaultLayout().ventLoss);
    old.ventLoss = -1;
    expect(() => parseLayout(JSON.stringify(old))).toThrow();
  });
  it('rejects corrupt input', () => {
    expect(() => parseLayout('{')).toThrow();
    expect(() => parseLayout('{"version":1}')).toThrow();
    const bad = JSON.parse(serialiseLayout(defaultLayout()));
    bad.fans[0].rpm = 'fast';
    expect(() => parseLayout(JSON.stringify(bad))).toThrow();
    bad.fans[0].rpm = 100;
    bad.fans[0].model = 'nope';
    expect(() => parseLayout(JSON.stringify(bad))).toThrow();
  });
});
