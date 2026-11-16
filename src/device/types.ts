/** Layout family a model's ZMDB uses. */
export type ZuneModelFamily = 'hd' | 'classic';

/** A recognised Zune model. */
export interface ZuneModel {
  /** USB product ID. */
  productId: number;
  /** Marketing name. */
  name: string;
  /** Short name used in filenames and logs. */
  shortName: string;
  /** ZMDB layout family. */
  family: ZuneModelFamily;
  /** Hardware generation label. */
  generation: string;
  /**
   * Nominal capacity in decimal gigabytes.
   *
   * A product ID covers several capacities, so this is what distinguishes
   * a Zune 8 from a Zune 30 on the same `0x0710` product ID.
   */
  capacityGb?: number;
}

/** A Zune seen on the USB bus. */
export interface ZuneUsbDevice {
  vendorId: number;
  productId: number;
  model: ZuneModel;
  /** USB serial number, when the platform exposes it. */
  serialNumber?: string;
}
