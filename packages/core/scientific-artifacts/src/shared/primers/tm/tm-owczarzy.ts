export interface OwczarzyConditions {
  monovalentM: number;

  divalentM: number;

  dntpM: number;
}

function applyMonovalent2004(invTm: number, fGC: number, monovalentM: number): number {
  if (monovalentM <= 0) return invTm;
  const lnNa = Math.log(monovalentM);
  return invTm + (4.29 * fGC - 3.95) * 1e-5 * lnNa + 9.4e-6 * lnNa * lnNa;
}

export function owczarzySaltCorrectedTmC(
  tm1MC: number,
  fGC: number,
  nBp: number,
  conditions: OwczarzyConditions
): number {
  const mono = Math.max(0, conditions.monovalentM);
  const freeMg = Math.max(0, conditions.divalentM - Math.max(0, conditions.dntpM));

  const tm1MK = tm1MC + 273.15;
  let invTm = 1 / tm1MK;

  if (freeMg <= 0) {
    invTm = applyMonovalent2004(invTm, fGC, mono);
    return 1 / invTm - 273.15;
  }

  const lnMg = Math.log(freeMg);
  let a = 3.92e-5;
  const b = -9.11e-6;
  const c = 6.26e-5;
  let d = 1.42e-5;
  const e = -4.82e-4;
  const f = 5.25e-4;
  let g = 8.31e-5;

  if (mono > 0) {
    const R = Math.sqrt(freeMg) / mono;
    if (R < 0.22) {
      invTm = applyMonovalent2004(invTm, fGC, mono);
      return 1 / invTm - 273.15;
    }
    if (R < 6.0) {
      const lnMono = Math.log(mono);
      a = 3.92e-5 * (0.843 - 0.352 * Math.sqrt(mono) * lnMono);
      d = 1.42e-5 * (1.279 - 4.03e-3 * lnMono - 8.03e-3 * lnMono * lnMono);
      g = 8.31e-5 * (0.486 - 0.258 * lnMono + 5.25e-3 * lnMono * lnMono * lnMono);
    }
  }

  invTm =
    invTm +
    a +
    b * lnMg +
    fGC * (c + d * lnMg) +
    (1 / (2 * (nBp - 1))) * (e + f * lnMg + g * lnMg * lnMg);

  return 1 / invTm - 273.15;
}
