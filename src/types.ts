export type LinkMode = "share" | "token";
export type LinkStatus = "active" | "killed" | "dead_upstream" | "needs_reauth";
export type ControlType = "Stop" | "Shock" | "Vibrate" | "Sound";

export const CONTROL_TYPES: readonly ControlType[] = ["Stop", "Shock", "Vibrate", "Sound"];

export interface ShockerDef {
  alias: string;
  upstreamId: string;
  deviceAlias: string;
  displayName: string;
  maxIntensity: number;
  maxDuration: number;
  allowShock: boolean;
  allowVibrate: boolean;
  allowSound: boolean;
  hidden: boolean;
  cooldownMs: number;
  sort: number;
}

export interface DeviceDef {
  alias: string;
  upstreamId: string;
  displayName: string;
  sort: number;
}

export interface LinkDef {
  id: string;
  holderId: string;
  slug: string;
  mode: LinkMode;
  upstreamBase: string;
  upstreamShareId?: string;
  upstreamToken?: string;
  title: string;
  authorText: string;
  status: LinkStatus;
  expiresAt: number;
  rlPerGuestPerMin: number;
  rlPerLinkPerMin: number;
  requireBotCheck: boolean;
  guestPasswordHash?: Buffer;
  createdAt: number;
  devices: DeviceDef[];
  shockers: ShockerDef[];
}

/** Upstream view of one shocker, as returned by the public share endpoint. */
export interface UpstreamShocker {
  id: string;
  name: string;
  permissions: { shock: boolean; vibrate: boolean; sound: boolean; live: boolean };
  limits: { intensity: number | null; duration: number | null };
  paused: number;
}

export interface UpstreamDevice {
  id: string;
  name: string;
  shockers: UpstreamShocker[];
}

export interface UpstreamShare {
  id: string;
  name: string;
  createdOn: string;
  expiresOn: string | null;
  devices: UpstreamDevice[];
}

export interface ControlCommand {
  alias: string;
  type: ControlType;
  intensity: number;
  duration: number;
  exclusive: boolean;
}
