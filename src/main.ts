import { step } from "./engine";
import { type Choice } from "./types";

const choice: Choice = { label: "Take the alley around back", next: "alley" };
console.log(step(choice));