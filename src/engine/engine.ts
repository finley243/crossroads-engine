import { type Option } from "./types";

export function step(choice: Option): string {
  return `> ${choice.label}`;
}