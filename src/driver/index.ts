// Picks the driver: DRIVER=cua (default, by platform) | sim (simulated desktop, no Cua needed).
import type { Driver } from "../contracts";
import { MacDriver } from "./mac";
import { SimDriver } from "./sim";
import { WinDriver } from "./win";

export function makeDriver(kind = process.env.DRIVER ?? "cua"): Driver {
  if (kind === "sim") return new SimDriver();
  if (kind !== "cua") throw new Error(`unknown DRIVER=${kind} (use cua or sim)`);
  if (process.platform === "win32") return new WinDriver();
  if (process.platform === "darwin") return new MacDriver();
  throw new Error(`no Cua driver for ${process.platform}; use DRIVER=sim`);
}
