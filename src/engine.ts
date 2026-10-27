import { type Choice } from "./types";

export function step(choice: Choice): string {
  return `> ${choice.label}`;
}