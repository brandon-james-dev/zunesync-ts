import { ZUNE_VENDOR_ID } from "../common/constants/index.js";
import { ZuneError } from "../common/errors/index.js";
import type { ZuneModel, ZuneUsbDevice } from "./types.js";

/**
 * Every model a Zune product ID can resolve to.
 *
 * The firmware exposes only two product IDs for the whole family, so a
 * product ID identifies a *family*, not a model:
 *
 *   0x0710 — Zune 4, 8, 16, 30, 80, 120 (all "classic" models)
 *   0x063e — Zune HD 16, 32, 64
 *
 * The specific model is recovered from the storage capacity the device
 * reports in `GetStorageInfo`, which is why {@link detectDevice} takes an
 * optional capacity.
 */
export const ZUNE_MODEL_VARIANTS: Record<number, ZuneModel[]> = {
  0x063e: [
    {
      productId: 0x063e,
      name: "Zune HD 16",
      shortName: "zune-hd-16",
      family: "hd",
      generation: "HD",
      capacityGb: 16,
    },
    {
      productId: 0x063e,
      name: "Zune HD 32",
      shortName: "zune-hd-32",
      family: "hd",
      generation: "HD",
      capacityGb: 32,
    },
    {
      productId: 0x063e,
      name: "Zune HD 64",
      shortName: "zune-hd-64",
      family: "hd",
      generation: "HD",
      capacityGb: 64,
    },
  ],
  0x0710: [
    {
      productId: 0x0710,
      name: "Zune 4",
      shortName: "zune-4",
      family: "classic",
      generation: "2",
      capacityGb: 4,
    },
    {
      productId: 0x0710,
      name: "Zune 8",
      shortName: "zune-8",
      family: "classic",
      generation: "2",
      capacityGb: 8,
    },
    {
      productId: 0x0710,
      name: "Zune 16",
      shortName: "zune-16",
      family: "classic",
      generation: "2",
      capacityGb: 16,
    },
    {
      productId: 0x0710,
      name: "Zune 30",
      shortName: "zune-30",
      family: "classic",
      generation: "1",
      capacityGb: 30,
    },
    {
      productId: 0x0710,
      name: "Zune 80",
      shortName: "zune-80",
      family: "classic",
      generation: "2",
      capacityGb: 80,
    },
    {
      productId: 0x0710,
      name: "Zune 120",
      shortName: "zune-120",
      family: "classic",
      generation: "2",
      capacityGb: 120,
    },
  ],
};

/**
 * Default model per product ID, used when no capacity is known.
 *
 * `0x0710` resolves to the family's smallest model rather than a specific
 * one, so a caller that has not read `GetStorageInfo` still gets a plausible
 * name instead of a wrong one.
 */
export const ZUNE_MODELS: Record<number, ZuneModel> = Object.fromEntries(
  Object.entries(ZUNE_MODEL_VARIANTS).map(([productId, variants]) => [
    Number(productId),
    variants[0],
  ])
);

/** Decimal bytes in one nominal gigabyte, as drive capacities are marketed. */
const BYTES_PER_GB = 1_000_000_000;

function parseProductId(productId: number | string): number {
  if (typeof productId === "number") return productId;
  const trimmed = productId.trim();
  return Number.parseInt(
    trimmed,
    trimmed.startsWith("0x") || trimmed.startsWith("0X") ? 16 : 10
  );
}

/**
 * Resolve a USB product ID to a Zune model.
 *
 * @param productId - USB product ID, as a number or a `0x`-prefixed string.
 * @param capacityBytes - `GetStorageInfo.maxCapacity` for the device. When
 *   supplied, it selects the exact model within a family PID; without it the
 *   family's default model is returned.
 * @throws {ZuneError} `DEVICE_NOT_FOUND` for an unknown product ID.
 */
export function detectDevice(
  productId: number | string,
  capacityBytes?: number | bigint | null
): ZuneModel {
  const id = parseProductId(productId);
  const variants = ZUNE_MODEL_VARIANTS[id];

  if (!variants?.length) {
    throw new ZuneError(
      "DEVICE_NOT_FOUND",
      `Unknown Zune product ID 0x${id.toString(16)}`
    );
  }

  if (variants.length === 1) return variants[0];
  if (capacityBytes === undefined || capacityBytes === null) return variants[0];

  const capacity = Number(capacityBytes);
  if (!Number.isFinite(capacity) || capacity <= 0) return variants[0];

  let best = variants[0];
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const variant of variants) {
    const nominal = (variant.capacityGb ?? 0) * BYTES_PER_GB;
    const distance = Math.abs(nominal - capacity);
    if (distance < bestDistance) {
      best = variant;
      bestDistance = distance;
    }
  }

  return best;
}

/** True when `productId` belongs to a known Zune. */
export function isZuneProductId(productId: number): boolean {
  return productId in ZUNE_MODEL_VARIANTS;
}

/** Every model a product ID can resolve to, in ascending capacity order. */
export function getZuneModelVariants(productId: number): ZuneModel[] {
  return ZUNE_MODEL_VARIANTS[productId] ?? [];
}

/**
 * Enumerate Zunes currently attached, using the optional `usb` package.
 *
 * This only reads descriptors; it does not open or claim the device, so it
 * is safe to call while another process owns the MTP session. Because the
 * descriptors carry no capacity, each entry reports the family's default
 * model — call {@link detectDevice} with `GetStorageInfo.maxCapacity` for the
 * exact one.
 */
export async function listZuneDevices(): Promise<ZuneUsbDevice[]> {
  interface UsbListModule {
    usb: {
      getDeviceList(): Array<{
        deviceDescriptor: {
          idVendor: number;
          idProduct: number;
          iSerialNumber?: number;
        };
      }>;
    };
  }

  const specifier = "usb";
  let module: UsbListModule;
  try {
    // `/* @vite-ignore */`: the specifier is a variable so the browser bundle
    // never resolves `usb`; without this Vite warns that the dynamic import
    // cannot be analysed on every dev-server start.
    module = (await import(/* @vite-ignore */ specifier)) as unknown as UsbListModule;
  } catch {
    throw new ZuneError(
      "NOT_CONNECTED",
      'The optional "usb" package is not installed. Run `npm install usb` to enumerate devices.'
    );
  }

  const devices: ZuneUsbDevice[] = [];
  for (const device of module.usb.getDeviceList()) {
    const { idVendor, idProduct } = device.deviceDescriptor;
    if (idVendor !== ZUNE_VENDOR_ID) continue;
    const model = ZUNE_MODELS[idProduct];
    if (!model) continue;
    devices.push({ vendorId: idVendor, productId: idProduct, model });
  }
  return devices;
}
