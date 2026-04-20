import { randomBytes } from "node:crypto";

export interface RandomIdSource {
  next(): string;
}

export const cryptoRandomIdSource: RandomIdSource = {
  next(): string {
    return randomBytes(32).toString("hex");
  },
};
