// HeatTwin sideline node — thermistor test (Arduino Uno R3)
//
// Reads up to two 10 kΩ NTC thermistors as voltage dividers and prints CSV over USB serial (115200 baud):
//   A0 = GLOBE thermistor (inside the black ping-pong ball, in the sun, 3 ft up)
//   A1 = AIR thermistor (optional; in the shade, inside a white cup with holes)
// Wiring for each channel:  5V ── thermistor ── A0 ── 10 kΩ resistor ── GND
// A channel with nothing plugged in prints "nan".
//
// Output line:  ms,globe_adc,globe_ohm,globe_c,air_adc,air_ohm,air_c
//
// Calibration: BETA below is the common value for hobby 10 kΩ NTCs, NOT measured for your part. Do the two-point
// check in firmware/README.md (ice water + room temperature with the kitchen thermometer) and paste the printed
// resistances back so BETA (and R0) can be set from your own thermistor.

const float VCC_COUNTS = 1023.0;   // Uno 10-bit ADC; divider ratio is independent of the actual 5 V level
const float R_FIXED = 10000.0;     // the 10 kΩ resistor to GND (measure it with a multimeter if you have one)
const float R0 = 10000.0;          // thermistor resistance at T0 (nominal 10 kΩ)
const float T0_C = 25.0;           // reference temperature for R0
const float BETA = 3950.0;         // TODO: replace with the value from your two-point calibration
const int SAMPLES = 16;            // readings averaged per channel (reduces ADC noise)
const unsigned long PERIOD_MS = 2000;

const int PIN_GLOBE = A0;
const int PIN_AIR = A1;

float readAdc(int pin) {
  long sum = 0;
  for (int i = 0; i < SAMPLES; i++) {
    sum += analogRead(pin);
    delay(2);
  }
  return sum / (float)SAMPLES;
}

// Thermistor on the high side: V_A0 = 5V * R_FIXED / (R_th + R_FIXED)  →  R_th = R_FIXED * (1023/adc - 1)
float thermistorOhms(float adc) {
  if (adc < 5 || adc > 1018) return NAN;   // open circuit (nothing plugged in) or shorted
  return R_FIXED * (VCC_COUNTS / adc - 1.0);
}

// Beta equation: 1/T = 1/T0 + ln(R/R0)/B   (T in kelvin)
float ohmsToC(float r) {
  if (isnan(r)) return NAN;
  float invT = 1.0 / (T0_C + 273.15) + log(r / R0) / BETA;
  return 1.0 / invT - 273.15;
}

void printChannel(float adc) {
  float r = thermistorOhms(adc);
  Serial.print(adc, 1);
  Serial.print(',');
  if (isnan(r)) Serial.print("nan"); else Serial.print(r, 0);
  Serial.print(',');
  float c = ohmsToC(r);
  if (isnan(c)) Serial.print("nan"); else Serial.print(c, 2);
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("# HeatTwin thermistor test: A0=globe, A1=air. BETA not yet calibrated.");
  Serial.println("ms,globe_adc,globe_ohm,globe_c,air_adc,air_ohm,air_c");
}

void loop() {
  unsigned long t = millis();
  Serial.print(t);
  Serial.print(',');
  printChannel(readAdc(PIN_GLOBE));
  Serial.print(',');
  printChannel(readAdc(PIN_AIR));
  Serial.println();
  while (millis() - t < PERIOD_MS) {}
}
