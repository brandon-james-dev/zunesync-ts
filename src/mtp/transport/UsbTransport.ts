import { ZUNE_VENDOR_ID } from '../../common/constants/index.js';
import { ZuneError } from '../../common/errors/index.js';
import type { MtpTransport } from './types.js';

interface UsbEndpointLike {
  direction: string;
  type: string;
  endpointNumber: number;
}

interface UsbAlternateLike {
  alternateSetting: number;
  interfaceClass: number;
  interfaceSubclass: number;
  interfaceProtocol: number;
  endpoints: UsbEndpointLike[];
}

interface UsbInterfaceLike {
  interfaceNumber: number;
  alternates: UsbAlternateLike[];
}

interface UsbConfigurationLike {
  configurationValue: number;
  interfaces: UsbInterfaceLike[];
}

interface UsbDeviceLike {
  productId: number;
  configuration: UsbConfigurationLike | null;
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(value: number): Promise<void>;
  claimInterface(number: number): Promise<void>;
  releaseInterface(number: number): Promise<void>;
  transferOut(endpoint: number, data: Uint8Array): Promise<{ status: string }>;
  transferIn(endpoint: number, length: number): Promise<{ status: string; data: Uint8Array }>;
  clearHalt(direction: string, endpoint: number): Promise<void>;
  controlTransferOut(
    setup: {
      requestType: string;
      recipient: string;
      request: number;
      value: number;
      index: number;
    },
    data?: Uint8Array,
  ): Promise<{ status: string; bytesWritten?: number }>;
  controlTransferIn(
    setup: {
      requestType: string;
      recipient: string;
      request: number;
      value: number;
      index: number;
    },
    length: number,
  ): Promise<{ status: string; data?: DataView }>;
}

interface WebUsbLike {
  requestDevice(options: { filters: Array<{ vendorId: number; productId: number }> }): Promise<UsbDeviceLike>;
}

interface UsbModuleLike {
  WebUSB: new (options: { allowAllDevices: boolean }) => WebUsbLike;
  usb: {
    on(event: 'attach' | 'detach', listener: (device: { deviceDescriptor: { idVendor: number; idProduct: number } }) => void): void;
    removeAllListeners(event: 'attach' | 'detach'): void;
  };
}

/** Load the optional `usb` package without a static dependency on it. */
async function loadUsb(): Promise<UsbModuleLike> {
  const specifier = 'usb';
  try {
    // `/* @vite-ignore */`: the specifier is a variable so the browser bundle
    // never resolves `usb`; without this Vite warns that the dynamic import
    // cannot be analysed on every dev-server start.
    return (await import(/* @vite-ignore */ specifier)) as unknown as UsbModuleLike;
  } catch {
    throw new ZuneError(
      'NOT_CONNECTED',
      'The optional "usb" package is not installed. Run `npm install usb` to use USB transports.',
    );
  }
}

/**
 * USB bulk transport for a Zune, backed by the optional `usb` package.
 *
 * MTP runs over the PTP interface (class 6, subclass 1, protocol 1). When
 * a device does not expose that triple the transport falls back to the
 * first interface that has both bulk IN and bulk OUT endpoints.
 */
export class UsbTransport implements MtpTransport {
  private device: UsbDeviceLike | null = null;
  private webusb: WebUsbLike | null = null;
  private usbModule: UsbModuleLike['usb'] | null = null;
  private bulkOutEndpoint: number | null = null;
  private bulkInEndpoint: number | null = null;
  private mtpInterface: number | null = null;
  private readonly attachCallbacks: Array<(productId: number) => void> = [];
  private readonly detachCallbacks: Array<() => void> = [];

  /** Open the first Zune matching `productId` (or any Zune when omitted). */
  async open(productId?: number): Promise<void> {
    const module = await loadUsb();
    this.usbModule = module.usb;
    this.webusb = new module.WebUSB({ allowAllDevices: true });

    const filters = productId === undefined
      ? [{ vendorId: ZUNE_VENDOR_ID, productId: 0x063e }, { vendorId: ZUNE_VENDOR_ID, productId: 0x0710 }]
      : [{ vendorId: ZUNE_VENDOR_ID, productId }];

    let device: UsbDeviceLike | null = null;
    try {
      device = await this.webusb.requestDevice({ filters });
    } catch {
      device = null;
    }

    if (!device) {
      throw new ZuneError(
        'DEVICE_NOT_FOUND',
        `Zune device not found (VID=0x${ZUNE_VENDOR_ID.toString(16)}, PID=${productId === undefined ? 'any' : `0x${productId.toString(16)}`})`,
      );
    }

    this.device = device;
    await this.openDevice();
  }

  /** Wrap an already-opened libusb device (used by hotplug callbacks). */
  async openFromDevice(device: UsbDeviceLike): Promise<void> {
    this.device = device;
    await this.openDevice();
  }

  private async openDevice(): Promise<void> {
    if (!this.device) throw new ZuneError('NOT_CONNECTED', 'No USB device selected');
    await this.device.open();

    // `configuration` is not a safe read on an unconfigured device: node-usb
    // throws "configuration error: device is not configured" instead of
    // returning null, so testing it directly threw before the device was ever
    // configured and the transport could not open at all.
    let configured = false;
    try {
      configured = this.device.configuration !== null;
    } catch {
      configured = false;
    }
    if (!configured) await this.device.selectConfiguration(1);

    this.discoverEndpoints();
    if (this.mtpInterface === null) throw new ZuneError('DEVICE_NOT_FOUND', 'No MTP interface found');
    await this.device.claimInterface(this.mtpInterface);
  }

  private discoverEndpoints(): void {
    const configuration = this.device?.configuration;
    if (!configuration) throw new ZuneError('DEVICE_NOT_FOUND', 'No active USB configuration');

    let match: { iface: UsbInterfaceLike; alt: UsbAlternateLike } | null = null;

    for (const iface of configuration.interfaces) {
      for (const alt of iface.alternates) {
        if (alt.interfaceClass === 6 && alt.interfaceSubclass === 1 && alt.interfaceProtocol === 1) {
          match = { iface, alt };
          break;
        }
      }
      if (match) break;
    }

    if (!match) {
      for (const iface of configuration.interfaces) {
        for (const alt of iface.alternates) {
          const hasIn = alt.endpoints.some((e) => e.direction === 'in' && e.type === 'bulk');
          const hasOut = alt.endpoints.some((e) => e.direction === 'out' && e.type === 'bulk');
          if (hasIn && hasOut) {
            match = { iface, alt };
            break;
          }
        }
        if (match) break;
      }
    }

    if (!match) throw new ZuneError('DEVICE_NOT_FOUND', 'No MTP interface found on device');

    this.mtpInterface = match.iface.interfaceNumber;
    for (const endpoint of match.alt.endpoints) {
      if (endpoint.type !== 'bulk') continue;
      if (endpoint.direction === 'out') this.bulkOutEndpoint = endpoint.endpointNumber;
      else if (endpoint.direction === 'in') this.bulkInEndpoint = endpoint.endpointNumber;
    }

    if (this.bulkOutEndpoint === null || this.bulkInEndpoint === null) {
      throw new ZuneError('DEVICE_NOT_FOUND', 'MTP interface missing bulk endpoints');
    }
  }

  async bulkWrite(data: Uint8Array): Promise<void> {
    if (!this.device || this.bulkOutEndpoint === null) {
      throw new ZuneError('NOT_CONNECTED', 'USB transport is not open');
    }
    let result: { status: string };
    try {
      result = await this.device.transferOut(this.bulkOutEndpoint, data);
    } catch (error) {
      // node-usb throws raw libusb errors ("transferOut error: Stall") rather
      // than returning a status, so wrap them: the protocol needs a code to
      // decide whether to clear the halt.
      throw new ZuneError('MTP_TRANSPORT', `USB bulk write failed: ${(error as Error).message}`);
    }
    if (result.status !== 'ok') {
      throw new ZuneError('MTP_TRANSPORT', `USB bulk write failed: ${result.status}`);
    }
  }

  async bulkRead(length: number): Promise<Uint8Array> {
    if (!this.device || this.bulkInEndpoint === null) {
      throw new ZuneError('NOT_CONNECTED', 'USB transport is not open');
    }
    let result: { status: string; data: unknown };
    try {
      result = await this.device.transferIn(this.bulkInEndpoint, length);
    } catch (error) {
      throw new ZuneError('MTP_TRANSPORT', `USB bulk read failed: ${(error as Error).message}`);
    }
    if (result.status !== 'ok') {
      throw new ZuneError('MTP_TRANSPORT', `USB bulk read failed: ${result.status}`);
    }
    // WebUSB hands back a `DataView`, while node-usb's libusb path hands back a
    // `Buffer`. Returning the DataView unchanged made every caller treat it as a
    // byte array, so `length` was undefined and the first container read failed
    // with "Container shorter than 12 bytes". Copy through the view's own
    // window so a pooled Buffer's backing store is not over-read.
    const data = result.data;
    if (data instanceof Uint8Array) {
      return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    }
    if (data instanceof DataView) {
      return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    }
    if (data instanceof ArrayBuffer) {
      return new Uint8Array(data.slice(0));
    }
    throw new ZuneError('MTP_TRANSPORT', 'USB bulk read returned no byte data');
  }

  /** Clear a stalled bulk endpoint, ignoring devices that refuse the request. */
  async clearHalt(direction: 'in' | 'out'): Promise<void> {
    if (!this.device) return;
    const endpoint = direction === 'in' ? this.bulkInEndpoint : this.bulkOutEndpoint;
    if (endpoint === null) return;
    try {
      await this.device.clearHalt(direction, endpoint);
    } catch {
      // Best effort only.
    }
  }

  /**
   * A still-image class request on the claimed interface.
   *
   * PTP-over-USB cancellation needs Cancel Request (0x64) and Get Device Status
   * (0x67); without them a timed-out transaction cannot be cancelled and the
   * device wedges until it is unplugged.
   */
  async classRequest(
    requestType: number,
    request: number,
    data: Uint8Array,
    length: number,
    _timeoutMs: number,
  ): Promise<number> {
    if (!this.device) throw new ZuneError('NOT_CONNECTED', 'USB transport is not open');

    const setup = {
      requestType: 'class' as const,
      recipient: 'interface' as const,
      request,
      value: 0,
      index: this.mtpInterface ?? 0,
    };

    if (requestType === 0x21) {
      const result = await this.device.controlTransferOut(setup, data);
      return result.status === 'ok' ? result.bytesWritten ?? data.length : -1;
    }

    const result = await this.device.controlTransferIn(setup, length);
    if (result.status !== 'ok' || !result.data) return -1;
    const view = result.data;
    const bytes = new Uint8Array(
      view.buffer,
      view.byteOffset,
      Math.min(view.byteLength, length),
    );
    data.set(bytes.subarray(0, Math.min(bytes.length, data.length)));
    return bytes.length;
  }

  /** Register a callback fired when a Zune is attached. */
  onAttach(callback: (productId: number) => void): void {
    this.attachCallbacks.push(callback);
  }

  /** Register a callback fired when a Zune is detached. */
  onDetach(callback: () => void): void {
    this.detachCallbacks.push(callback);
  }

  /** Start libusb hotplug detection for Zune vendor IDs. */
  async startHotplugDetection(): Promise<void> {
    if (!this.usbModule) {
      const module = await loadUsb();
      this.usbModule = module.usb;
    }
    this.usbModule.on('attach', (device) => {
      const { idVendor, idProduct } = device.deviceDescriptor;
      if (idVendor !== ZUNE_VENDOR_ID) return;
      for (const callback of this.attachCallbacks) callback(idProduct);
    });
    this.usbModule.on('detach', (device) => {
      const { idVendor } = device.deviceDescriptor;
      if (idVendor !== ZUNE_VENDOR_ID) return;
      for (const callback of this.detachCallbacks) callback();
    });
  }

  /** Stop hotplug detection. */
  stopHotplugDetection(): void {
    this.usbModule?.removeAllListeners('attach');
    this.usbModule?.removeAllListeners('detach');
  }

  async close(): Promise<void> {
    if (!this.device) return;
    if (this.mtpInterface !== null) {
      try {
        await this.device.releaseInterface(this.mtpInterface);
      } catch {
        // Best effort only.
      }
    }
    try {
      await this.device.close();
    } catch {
      // Best effort only.
    }
    this.device = null;
    this.bulkOutEndpoint = null;
    this.bulkInEndpoint = null;
    this.mtpInterface = null;
  }

  /**
   * Close and reopen the device, cancelling any in-flight transfer.
   *
   * A timed-out `transferIn` stays in flight inside libusb and blocks every
   * later transfer, so clearing the halt does not recover the session. Closing
   * and reopening does — verified on a Zune 120, where the read after recovery
   * returned `"09 Higher.mp3"` instead of hanging.
   */
  async recover(): Promise<void> {
    const productId = this.device?.productId;
    await this.close();
    await this.open(productId);
  }
}
