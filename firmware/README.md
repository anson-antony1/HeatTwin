# Sideline node with an Arduino Uno R3 and a thermistor

Hardware we have: Arduino Uno R3, a 10 kΩ NTC thermistor, 10 kΩ resistors, breadboard, jumpers.
The Uno has no WiFi; it sends readings over USB to the laptop (`engine/node_bridge.py` will forward them).

## 1. Wire it (one channel = one thermistor + one 10 kΩ resistor)

```
 Uno 5V ───────────┐
                   │
              [thermistor]        ← the GLOBE thermistor (later: inside the black ball)
                   │
 Uno A0 ───────────┤              ← the junction between the two parts
                   │
              [10 kΩ resistor]    ← brown-black-orange bands
                   │
 Uno GND ──────────┘
```

On a breadboard:
1. Thermistor leg 1 → a hole in row 10. Thermistor leg 2 → row 15. (Polarity doesn't matter.)
2. 10 kΩ resistor: one leg in **row 15**, other leg in row 20.
3. Jumper **Uno 5V → row 10**.
4. Jumper **Uno A0 → row 15** (the middle, where thermistor and resistor meet).
5. Jumper **Uno GND → row 20**.

Optional second channel (shaded **air** temperature, same parts): repeat on rows 30/35/40 with **A1** instead of A0.
If you have no second thermistor, leave A1 unconnected and ignore the `air_` columns (an unconnected pin can show
random values).

**If your thermistor is a small 3-pin module** (Elegoo kits): it has its own resistor on board. Wire
`S`/signal → A0, `+`/middle → 5V, `-` → GND and skip the separate 10 kΩ. If temperature goes *down* when you warm it,
tell Claude; the module puts the thermistor on the other side of the divider and the formula flips.

## 2. Upload and read
1. Arduino IDE → open `firmware/thermistor_test/thermistor_test.ino` → Tools ▸ Board ▸ **Arduino Uno**, Tools ▸ Port ▸
   the `/dev/ttyACM0` (or similar) port → Upload.
   On Linux, if upload fails with "permission denied": `sudo usermod -aG dialout $USER`, then log out and back in.
2. Tools ▸ **Serial Monitor**, set **115200 baud**. A line every 2 s:
   `ms,globe_adc,globe_ohm,globe_c,air_adc,air_ohm,air_c`
3. Sanity checks: at room temperature `globe_ohm` ≈ 10 000 and `globe_c` ≈ 20–25. Pinch the thermistor between your
   fingers: temperature rises within seconds. If it falls instead, swap the thermistor and the resistor positions.

## 3. Calibrate (5 min; needed for real numbers)
The sketch uses `BETA = 3950`, a typical value, not one measured for *your* thermistor.
1. **Ice water**: a cup packed with ice, topped with water, stirred. Dip the thermistor tip (keep the leg wires dry —
   wrap the joint in tape or a small plastic bag). Wait 1 min. Note `globe_ohm`. (Ice water = 0.0 °C.)
2. **Room**: thermistor and kitchen thermometer side by side in still room air for 2 min. Note `globe_ohm` and the
   kitchen thermometer's °C.
3. Send both pairs to Claude. It will compute `BETA = ln(R_ice/R_room) / (1/273.15 − 1/T_room_K)` and set `R0`/`T0_C`,
   and record the result in `firmware/calibration.json`.

## 4. Build the globe
1. Make a hole about the thermistor's width in a ping-pong ball (heat a nail or use a small drill bit).
2. Push the thermistor in so its tip sits at the **center** of the ball, not touching the shell. Seal the hole with
   hot glue or tape so outside air can't blow through.
3. Wrap the ball smoothly in **black electrical tape** (no gaps or wrinkles; matte is better than glossy).
4. Extend the leads with jumper wires (twist + tape) long enough to reach the breadboard.

## 5. Mount outside (before sunset)
- Globe on the broom handle or tripod **3 ft (0.9 m) above the grass, in full sun**, away from walls and cars
  (FHSAA Policy 41.7.3–41.7.4).
- Air thermistor (if you have one): same height, **shaded** inside a white cup with holes for airflow, open end
  down. Never in direct sun.
- Laptop in the shade with the USB extension. Let it settle for 15–20 minutes before you trust the numbers
  (FHSAA 41.7.2).
- Save the Serial Monitor output, or (better) let `engine/node_bridge.py` log it to `data/node_<date>.csv` (next step).

## What the readings are used for
WBGT = 0.7·wet-bulb + 0.2·globe + 0.1·air. `engine/wbgt.py: node_components()` uses **globe − air** to infer the
sunlight the globe is absorbing, then computes Liljegren's wet-bulb and standard-globe temperatures from it. Humidity
and wind come from the NWS forecast until we have an RH sensor. A 40 mm ball is not the 150 mm standard globe, so
we report "our field vs. the forecast" and don't present it as a certified WBGT meter.
