import { expect, it } from "vitest";
import { contentTypeParameters } from "../mime.ts";

it.each([
  ["text/html; charset = UTF-8", [["charset", "UTF-8"]]],
  ['text/html; charset="iso-8859-1"', [["charset", "iso-8859-1"]]],
  ["text/html; charset='iso-8859-5'", [["charset", "iso-8859-5"]]],
  ["text/html; charset=", [["charset", ""]]],
  ["text/html", []],
  ["", []],
  [
    'text/html; x="charset=utf-7"; charset=utf-8',
    [
      ["x", "charset=utf-7"],
      ["charset", "utf-8"],
    ],
  ],
  [
    'text/plain; note="a\\\";charset=decoy"; charset=utf-8',
    [
      ["note", 'a\\\";charset=decoy'],
      ["charset", "utf-8"],
    ],
  ],
] as const)(
  "parses Content-Type parameters in %s without splitting quoted values",
  (input, expected) => {
    expect([...contentTypeParameters(input)]).toEqual(expected);
  },
);
