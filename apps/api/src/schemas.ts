import { z } from 'zod';

// Base shapes carry no defaults, so PATCH (partial) never overwrites a field the caller did not send.
// Create schemas add the defaults. Optional fields are nullable so an update can clear them (for example blanking an
// asset's rate makes it fall back to its type's default).

export const clientBase = z.object({ name: z.string().min(1), code: z.string().min(1).nullable(), currency: z.string().length(3) });
export const clientCreate = clientBase.extend({ code: clientBase.shape.code.optional(), currency: clientBase.shape.currency.default('NZD') });
export const clientPatch = clientBase.partial();

export const regionBase = z.object({ code: z.string().min(1).max(20), name: z.string().min(1) });
export const regionCreate = regionBase;
export const regionPatch = regionBase.partial();

export const siteBase = z.object({
  code: z.string().min(1), name: z.string().min(1), siteClass: z.string().nullable(), address: z.string().nullable(),
  regionId: z.string().uuid().nullable(),
  latitude: z.number().min(-90).max(90).nullable(), longitude: z.number().min(-180).max(180).nullable(),
  hazards: z.string().nullable(), attributes: z.record(z.string(), z.unknown()),
});
export const siteCreate = siteBase.partial().required({ code: true, name: true }).extend({ attributes: siteBase.shape.attributes.default({}) });
export const sitePatch = siteBase.partial();

export const typeBase = z.object({
  name: z.string().min(1), parentId: z.string().uuid().nullable(), expectedLifeYears: z.number().int().positive().nullable(),
  unit: z.string().nullable(), unitRate: z.number().nonnegative().nullable(),
});
export const typeCreate = typeBase.partial().required({ name: true });
export const typePatch = typeBase.partial();

export const assetBase = z.object({
  name: z.string().min(1), parentId: z.string().uuid().nullable(), assetTypeId: z.string().uuid().nullable(),
  manufacturer: z.string().nullable(), serialNumber: z.string().nullable(), installDate: z.string().date().nullable(),
  quantity: z.number().nonnegative(), unit: z.string().nullable(), unitRate: z.number().nonnegative().nullable(),
  expectedLifeYears: z.number().int().positive().nullable(), criticality: z.number().int().min(1).max(5).nullable(),
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
