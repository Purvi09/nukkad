// How you look while you walk. No roles, no perks — just a person in a coat.

export type Look = {
  id: string;
  name: string;
  coat: number;
  trousers: number;
  hat: number;
  skin: number;
};

export const LOOKS: Look[] = [
  { id: "rose",   name: "Rose",   coat: 0xd4708f, trousers: 0x4a3f52, hat: 0x8f4a63, skin: 0xf4d4ac },
  { id: "moss",   name: "Moss",   coat: 0x5f9160, trousers: 0x35424a, hat: 0x3f6b45, skin: 0xe0b98f },
  { id: "ochre",  name: "Ochre",  coat: 0xd39a3c, trousers: 0x4a4034, hat: 0x8a6224, skin: 0xc98f63 },
  { id: "violet", name: "Violet", coat: 0x8a6fb8, trousers: 0x3a3446, hat: 0x5b4685, skin: 0xf0cfb2 },
  { id: "sky",    name: "Sky",    coat: 0x5b8fc4, trousers: 0x36404f, hat: 0x3d6690, skin: 0xe8c3a0 },
  { id: "clay",   name: "Clay",   coat: 0xc4634f, trousers: 0x453a36, hat: 0x8a4133, skin: 0xd9a97c },
];

export const lookById = (id: string) => LOOKS.find((l) => l.id === id) ?? LOOKS[0];

/** A little portrait, drawn the same way the walking figure is. */
export const lookSvg = (l: Look) => {
  const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;
  return `<svg viewBox="0 0 40 52" width="100%" height="100%" shape-rendering="crispEdges">
    <ellipse cx="21" cy="49" rx="11" ry="3" fill="#000" opacity="0.16"/>
    <rect x="14" y="36" width="5" height="12" fill="${hex(l.trousers)}"/>
    <rect x="21" y="36" width="5" height="12" fill="${hex(l.trousers)}"/>
    <rect x="11" y="19" width="18" height="18" rx="3" fill="${hex(l.coat)}"/>
    <rect x="11" y="25" width="18" height="2" fill="#000" opacity="0.16"/>
    <rect x="11" y="19" width="18" height="4" rx="2" fill="#fff" opacity="0.3"/>
    <rect x="7" y="20" width="4" height="12" rx="2" fill="${hex(l.coat)}"/>
    <rect x="29" y="20" width="4" height="12" rx="2" fill="${hex(l.coat)}"/>
    <circle cx="20" cy="13" r="7" fill="${hex(l.skin)}"/>
    <circle cx="23" cy="12" r="1.1" fill="#2b2119"/>
    <rect x="10" y="6" width="20" height="3" fill="${hex(l.hat)}"/>
    <rect x="14" y="1" width="12" height="6" rx="2" fill="${hex(l.hat)}"/>
  </svg>`;
};
