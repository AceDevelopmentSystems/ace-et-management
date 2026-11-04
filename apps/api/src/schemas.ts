import { z } from 'zod';

// Base shapes carry no defaults, so PATCH (partial) never overwrites a field the caller did not send.
// Create schemas add the defaults.

export const clientBase = z.object({ name: z.string().min(1), code: z.string().min(1), currency: z.string().length(3) });
export const clientCreate = clientBase.extend({ code: clientBase.shape.code.optional(), currency: clientBase.shape.currency.default('NZD') });
export const clientPatch = clientBase.partial();

export const siteBase = z.object({
  code: z.string().min(1), name: z.string().min(1), siteClass: z.string(), address: z.string(),
  latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180),
  hazards: z.string(), attributes: z.record(z.string(), z.unknown()),
});
export const siteCreate = siteBase.partial().required({ code: true, name: true }).extend({ attributes: siteBase.shape.attributes.default({}) });
export const sitePatch = siteBase.partial();

export const typeBase = z.object({
  name: z.string().min(1), parentId: z.string().uuid(), expectedLifeYears: z.number().int().positive(),
  unit: z.string(), unitRate: z.number().nonnegative(),
});
export const typeCreate = typeBase.partial().required({ name: true });
export const typePatch = typeBase.partial();

export const assetBase = z.object({
  name: z.string().min(1), parentId: z.string().uuid(), assetTypeId: z.string().uuid(),
  manufacturer: z.string(), serialNumber: z.string(), installDate: z.string().date(),
  quantity: z.number().nonnegative(), unit: z.string(), unitRate: z.number().nonnegative(),
  expectedLifeYears: z.number().int().positive(), criticality: z.number().int().min(1).max(5),
  attributes: z.record(z.string(), z.unknown()),
});
export const assetCreate = assetBase.partial().required({ name: true }).extend({
  quantity: assetBase.shape.quantity.default(1), attributes: assetBase.shape.attributes.default({}),
});
export const assetPatch = assetBase.partial();

export const scenarioSchema = z.object({
  startYear: z.number().int().min(2000).max(2200),
  horizonYears: z.number().int().min(1).max(50),
  inflation: z.number().min(0).max(1).default(0),
  discountRate: z.number().min(0).max(1).default(0),
  overdue: z.enum(['year1', 'spread', 'ignore']).default('year1'),
  overdueSpreadYears: z.number().int().min(1).max(20).default(3),
  annualCap: z.number().nonnegative().optional(),
});
export const namedScenarioSchema = z.object({ name: z.string().min(1), params: scenarioSchema });
