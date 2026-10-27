import { step } from "../engine/engine";
import { type Option } from "../engine/types";

const choice: Option = { index: 0, label: [{ kind:"text", text:"Take the alley around back" }], result: { kind: "plain", text: [{ kind: "text", text: "You take the alley." }] } };
console.log(step(choice));