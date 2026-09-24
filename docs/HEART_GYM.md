# Heart gym

Run deterministic single-fight practice through the real engine setup path:

```sh
bun tools/heart-gym.ts heart-a6.json --pretty
bun tools/heart-gym.ts heart-a6.json --cmd "play 3 1; end" --pretty
bun tools/heart-gym.ts heart-a6.json --commands commands.json
```

The spec is JSON:

```json
{
  "seed": "RUN62",
  "ascension": 6,
  "hp": 38,
  "maxHp": 116,
  "deck": [{ "defId": "STRIKE_RED" }, { "defId": "BASH" }],
  "relics": ["BURNING_BLOOD"],
  "potions": ["FAIRY_POTION", null, null],
  "encounter": "THE_HEART",
  "gold": 0,
  "keys": { "emerald": true, "ruby": true, "sapphire": true }
}
```

`encounter` defaults to `THE_HEART`. Known run-flow encounters such as
`SHIELD_AND_SPEAR`, `DONU_AND_DECA`, elite encounter ids, normal encounter ids,
and single monster ids are supported. Text commands use visible combat numbers:
`play <hand-iid> [enemy-slot]`, `potion <1-based-slot> [enemy-slot]`,
`choose <1-based-choice>[,...]`, `end`.
