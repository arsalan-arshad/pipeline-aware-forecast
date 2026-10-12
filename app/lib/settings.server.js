/**
 * Forecast settings for one shop: haircut, ship offset, horizon, supplier lead
 * time and per-stage probability overrides.
 *
 * Prisma is injected, so nothing here reads the environment, the clock or the
 * network. savePipelineSettings input is validated first and a failed validation makes
 * no Prisma call; a rejecting Prisma call propagates to the caller.
 */

export const DEFAULT_SETTINGS = Object.freeze({
  haircut: 1,
  shipOffsetDays: 7,
  horizonDays: 90,
  leadTimeDays: 14,
});

const configError = (message) => ({ ok: false, errorClass: "config", message });

// Form posts deliver strings; empty, null, undefined and non-numeric input is invalid.
const toNumber = (value) => {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return NaN;
};

const inRange = (n, min, max) => Number.isFinite(n) && n >= min && n <= max;
const wholeInRange = (n, min, max) => inRange(n, min, max) && Number.isInteger(n);

/**
 * @param {{ prisma: object, shop: string }} args
 * @returns {Promise<{ haircut: number, shipOffsetDays: number, horizonDays: number,
 *   leadTimeDays: number, stageOverrides: { stageName: string, probability: number }[] }>}
 */
export async function loadPipelineSettings({ prisma, shop }) {
  const row = await prisma.pipelineSetting.findUnique({ where: { shop } });
  const overrideRows = await prisma.stageProbabilityOverride.findMany({
    where: { shop },
    orderBy: { stageName: "asc" },
  });
  const pick = (key) => row?.[key] ?? DEFAULT_SETTINGS[key];
  return {
    haircut: pick("haircut"),
    shipOffsetDays: pick("shipOffsetDays"),
    horizonDays: pick("horizonDays"),
    leadTimeDays: pick("leadTimeDays"),
    stageOverrides: overrideRows.map((o) => ({
      stageName: o.stageName,
      probability: o.probability,
    })),
  };
}

/**
 * @param {object} args
 * @param {object} args.prisma
 * @param {string} args.shop
 * @param {number|string} args.haircut - 0..1
 * @param {number|string} args.shipOffsetDays - integer 0..90
 * @param {number|string} args.horizonDays - integer 7..365
 * @param {number|string} args.leadTimeDays - integer 0..180
 * @param {{ stageName: string, probability: number|string }[]} [args.stageOverrides]
 * @returns {Promise<{ ok: true } | { ok: false, errorClass: 'config', message: string }>}
 */
export async function savePipelineSettings({
  prisma,
  shop,
  haircut,
  shipOffsetDays,
  horizonDays,
  leadTimeDays,
  stageOverrides,
}) {
  if (typeof shop !== "string" || shop.trim() === "") {
    return configError("A shop is required.");
  }
  const haircutN = toNumber(haircut);
  if (!inRange(haircutN, 0, 1)) {
    return configError("Haircut must be between 0 and 1.");
  }
  const shipN = toNumber(shipOffsetDays);
  if (!wholeInRange(shipN, 0, 90)) {
    return configError(
      "Ship offset must be a whole number of days from 0 to 90.",
    );
  }
  const horizonN = toNumber(horizonDays);
  if (!wholeInRange(horizonN, 7, 365)) {
    return configError(
      "Horizon must be a whole number of days from 7 to 365.",
    );
  }
  const leadN = toNumber(leadTimeDays);
  if (!wholeInRange(leadN, 0, 180)) {
    return configError(
      "Lead time must be a whole number of days from 0 to 180.",
    );
  }

  const list = stageOverrides ?? [];
  if (!Array.isArray(list)) {
    return configError("Each stage needs a name of up to 80 characters.");
  }
  if (list.length > 100) return configError("You can add up to 100 stage overrides.");
  const overrides = [];
  const seen = new Set();
  for (const entry of list) {
    const name =
      typeof entry?.stageName === "string" ? entry.stageName.trim() : "";
    if (name.length < 1 || name.length > 80) {
      return configError("Each stage needs a name of up to 80 characters.");
    }
    const key = name.toLowerCase();
    if (seen.has(key)) return configError("Stage names must be unique.");
    seen.add(key);
    const probability = toNumber(entry.probability);
    if (!inRange(probability, 0, 100)) {
      return configError("Stage probability must be between 0 and 100.");
    }
    overrides.push({ stageName: name, probability });
  }

  const values = {
    haircut: haircutN,
    shipOffsetDays: shipN,
    horizonDays: horizonN,
    leadTimeDays: leadN,
  };
  const ops = [
    prisma.pipelineSetting.upsert({
      where: { shop },
      create: { shop, ...values },
      update: values,
    }),
    prisma.stageProbabilityOverride.deleteMany({ where: { shop } }),
  ];
  if (overrides.length > 0) {
    ops.push(
      prisma.stageProbabilityOverride.createMany({
        data: overrides.map((o) => ({
          shop,
          stageName: o.stageName,
          probability: o.probability,
        })),
      }),
    );
  }
  await prisma.$transaction(ops);
  return { ok: true };
}
