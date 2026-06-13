export interface ShippingAddressInput {
  name?: string;
  company?: string;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone?: string;
  email?: string;
}

export interface ParcelInput {
  weightOz: number;
  lengthIn?: number;
  widthIn?: number;
  heightIn?: number;
}

export interface VerifiedAddress {
  valid: boolean;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  messages: Array<{ source?: string; type?: string; text: string }>;
}

export interface ShippingRate {
  id: string;
  shipmentId: string;
  carrier: string;
  service: string;
  rate: number;
  currency: string;
  deliveryDays?: number | null;
  estDeliveryDate?: string | null;
}

export interface PurchasedLabel {
  shipmentId: string;
  trackingCode: string;
  trackingUrl?: string | null;
  labelUrl: string;
  labelFormat: string;
  rate: number;
  currency: string;
  carrier: string;
  service: string;
}

export interface ParsedParcelTag {
  weightOz: number;
  lengthIn?: number;
  widthIn?: number;
  heightIn?: number;
}
