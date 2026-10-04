// HeatTwin sideline node with zone LEDs (Arduino Uno R3)
//
// Wiring:  5V ── thermistor ── A0 ── 10 kΩ ── GND        (globe thermistor)
//          D11 ── 220 Ω ── green LED ── GND   D10 ── 220 Ω ── yellow LED ── GND   D9 ── 220 Ω ── red LED ── GND
//
// Serial out (115200, every 1 s), the format engine/node_bridge.py reads:
//   ms,globe_adc,globe_ohm,globe_c,air_adc,air_ohm,air_c
// Serial in: "Z<1-5>\n" from node_bridge = the engine's FHSAA zone for the latest reading. The LEDs show that zone,
// so they always match the web app. If no zone arrives for 5 s (laptop unplugged / bridge stopped), the Uno falls
// back to its own estimate: rise above the room baseline → RISE_TO_WBGT_F (engine/wbgt.py, constants.demo_node
// hot-day scenario) → zone. Fallback mode blinks the LED briefly every second so you can tell.
//
//   green = zone 1 · yellow = zones 2–3 · red = zone 4 · red blinking = zone 5 (FHSAA Policy 41 §41.8.3)
// Uncalibrated thermistor (nominal Beta). Synthetic demo mapping in fallback — not field data.

const int PIN_THERM = A0, PIN_GREEN = 11, PIN_YELLOW = 10, PIN_RED = 9;
const float R_FIXED = 10000.0, R0 = 10000.0, T0_C = 25.0, BETA = 3950.0;
const unsigned long PERIOD_MS = 1000, ENGINE_TIMEOUT_MS = 5000, BLINK_MS = 250;
const int BASELINE_SAMPLES = 5;
const float SUN_GAIN = 1.5;         // = constants.demo_node.sun_gain: a fingertip's rise counts 3x (demo sensitivity)

const float RISE_STEP_C = 2.0;
const float RISE_TO_WBGT_F[] = {80.0, 81.3, 82.6, 83.9, 85.2, 86.5, 87.7, 89.0,
                                90.2, 91.5, 92.7, 94.0, 95.2, 96.4, 97.7, 98.9};
const int N_TABLE = sizeof(RISE_TO_WBGT_F) / sizeof(RISE_TO_WBGT_F[0]);
const float ZONE_MAX_F[] = {82.0, 87.0, 90.0, 92.0};

int engineZone = 0;                 // 0 = none received yet
unsigned long engineZoneAt = 0;
int localZone = 1;
float baselineSum = 0;
int baselineN = 0;
char inBuf[8];
int inLen = 0;

float readAdc() {
  long sum = 0;
  for (int i = 0; i < 16; i++) { sum += analogRead(PIN_THERM); delay(2); }
  return sum / 16.0;
}

float ohmsOf(float adc) { return (adc < 5 || adc > 1018) ? NAN : R_FIXED * (1023.0 / adc - 1.0); }

float cOf(float r) { return isnan(r) ? NAN : 1.0 / (1.0 / (T0_C + 273.15) + log(r / R0) / BETA) - 273.15; }

int zoneOfWbgt(float w) {
  w = round(w * 10.0) / 10.0;
  for (int z = 0; z < 4; z++) if (w <= ZONE_MAX_F[z]) return z + 1;
  return 5;
}

float wbgtFromRise(float rise) {
  float x = rise / RISE_STEP_C;
  if (x <= 0) return RISE_TO_WBGT_F[0];
  if (x >= N_TABLE - 1) return RISE_TO_WBGT_F[N_TABLE - 1];
  int i = (int)x;
  return RISE_TO_WBGT_F[i] + (x - i) * (RISE_TO_WBGT_F[i + 1] - RISE_TO_WBGT_F[i]);
}

void setLeds(bool g, bool y, bool r) {
  digitalWrite(PIN_GREEN, g); digitalWrite(PIN_YELLOW, y); digitalWrite(PIN_RED, r);
}

void showZone(int z, bool fallback) {
  unsigned long t = millis();
  bool blinkOn = (t / BLINK_MS) % 2 == 0;
  bool dim = fallback && (t % 1000) < 120;           // fallback: short off-flick once a second
  bool g = z == 1, y = z == 2 || z == 3, r = z == 4 || (z == 5 && blinkOn);
  if (dim) g = y = r = false;
  setLeds(g, y, r);
}

void readCommands() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (inLen == 2 && inBuf[0] == 'Z' && inBuf[1] >= '1' && inBuf[1] <= '5') {
        engineZone = inBuf[1] - '0';
        engineZoneAt = millis();
      }
      inLen = 0;
    } else if (inLen < (int)sizeof(inBuf) - 1) {
      inBuf[inLen++] = c;
    } else {
      inLen = 0;
    }
  }
}

void printField(float adc) {
  float r = ohmsOf(adc), c = cOf(r);
  Serial.print(adc, 1); Serial.print(',');
  if (isnan(r)) Serial.print("nan"); else Serial.print(r, 0);
  Serial.print(',');
  if (isnan(c)) Serial.print("nan"); else Serial.print(c, 2);
}

void setup() {
  pinMode(PIN_GREEN, OUTPUT); pinMode(PIN_YELLOW, OUTPUT); pinMode(PIN_RED, OUTPUT);
  Serial.begin(115200);
  setLeds(1, 1, 1); delay(400); setLeds(0, 0, 0);
  Serial.println("# HeatTwin node+LEDs: A0=globe. LEDs follow Z<n> from node_bridge, else local estimate.");
  Serial.println("ms,globe_adc,globe_ohm,globe_c,air_adc,air_ohm,air_c");
}

void loop() {
  static unsigned long lastSample = 0;
  readCommands();
  unsigned long now = millis();

  if (now - lastSample >= PERIOD_MS) {
    lastSample = now;
    float adc = readAdc();
    float c = cOf(ohmsOf(adc));
    Serial.print(now); Serial.print(',');
    printField(adc);
    Serial.println(",0.0,nan,nan");                    // A1 not wired
    if (!isnan(c)) {
      if (baselineN < BASELINE_SAMPLES) { baselineSum += c; baselineN++; }
      else localZone = zoneOfWbgt(wbgtFromRise(SUN_GAIN * max(0.0f, c - baselineSum / baselineN)));
    }
  }

  bool engineFresh = engineZone > 0 && now - engineZoneAt < ENGINE_TIMEOUT_MS;
  if (baselineN < BASELINE_SAMPLES && !engineFresh) setLeds(0, (now / 300) % 2, 0);   // zeroing
  else showZone(engineFresh ? engineZone : localZone, !engineFresh);
}
