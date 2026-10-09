/*
 * ESP32 device firmware for iot-mcp-server (DEVICE_ADAPTER=http).
 *
 * Exposes the tiny HTTP contract the server expects:
 *   GET  /status   → {"name","kind","room","firmware","readings":{...},"actuators":{...},"meta":{...}}
 *   POST /command  ← {"type":"set_fan_speed","speed":60} | {"type":"set_relay","on":true}
 *                    {"type":"set_purifier_mode","mode":"auto"} | {"type":"identify"}
 *
 * Set DEVICE_KIND to match your hardware. Sensor reads are stubbed with clear TODOs —
 * drop in your SCD40 (CO2), PMS5003/SPS30 (PM), SGP40 (VOC) or SHT4x (temp/RH) driver.
 *
 * Libraries: ArduinoJson (v7). Board: any ESP32 (Arduino core 3.x).
 */
#include <WiFi.h>
#include <WebServer.h>
#include <ArduinoJson.h>

// ---------- configure me ----------
const char* WIFI_SSID = "YOUR_WIFI";
const char* WIFI_PASS = "YOUR_PASSWORD";
const char* DEVICE_NAME = "SafeAir Monitor";
const char* DEVICE_ROOM = "Conference Room A";
// One of: air_monitor | ventilation_fan | air_purifier | relay
const char* DEVICE_KIND = "air_monitor";
const char* FIRMWARE = "1.0.0";

const int LED_PIN = 2;      // on-board LED (identify)
const int FAN_PWM_PIN = 25; // ventilation fan PWM (ventilation_fan)
const int RELAY_PIN = 26;   // relay output (relay / purifier power)
// ----------------------------------

WebServer server(80);

int fanSpeed = 0;           // 0-100 %
bool relayOn = false;
String purifierMode = "off";
unsigned long identifyUntil = 0;

// TODO: replace these stubs with real sensor drivers.
float readCO2()         { return 600 + random(-30, 30); }
float readPM25()        { return 12.0 + random(-20, 20) / 10.0; }
float readPM10()        { return readPM25() * 1.4; }
float readTVOC()        { return 150 + random(-20, 20); }
float readTemperature() { return 24.0 + random(-5, 5) / 10.0; }
float readHumidity()    { return 52.0 + random(-10, 10) / 10.0; }

bool isKind(const char* k) { return strcmp(DEVICE_KIND, k) == 0; }

void applyOutputs() {
  analogWrite(FAN_PWM_PIN, map(fanSpeed, 0, 100, 0, 255));
  bool power = isKind("relay") ? relayOn : (isKind("air_purifier") ? purifierMode != "off" : false);
  digitalWrite(RELAY_PIN, power ? HIGH : LOW);
}

void handleStatus() {
  JsonDocument doc;
  doc["name"] = DEVICE_NAME;
  doc["kind"] = DEVICE_KIND;
  doc["room"] = DEVICE_ROOM;
  doc["firmware"] = FIRMWARE;

  JsonObject readings = doc["readings"].to<JsonObject>();
  readings["rssi"] = WiFi.RSSI();
  if (isKind("air_monitor")) {
    readings["co2"] = (int)readCO2();
    readings["pm25"] = round(readPM25() * 10) / 10.0;
    readings["pm10"] = round(readPM10() * 10) / 10.0;
    readings["tvoc"] = (int)readTVOC();
    readings["temperature"] = round(readTemperature() * 10) / 10.0;
    readings["humidity"] = round(readHumidity() * 10) / 10.0;
  }

  JsonObject act = doc["actuators"].to<JsonObject>();
  if (isKind("ventilation_fan")) act["fanSpeed"] = fanSpeed;
  if (isKind("relay")) act["relayOn"] = relayOn;
  if (isKind("air_purifier")) act["purifierMode"] = purifierMode;

  JsonObject meta = doc["meta"].to<JsonObject>();
  meta["uptimeSec"] = millis() / 1000;
  meta["freeHeap"] = ESP.getFreeHeap();
  if (millis() < identifyUntil) meta["identifyUntil"] = identifyUntil;

  String out;
  serializeJson(doc, out);
  server.send(200, "application/json", out);
}

void reply(int code, bool ok, const String& message) {
  JsonDocument doc;
  doc["ok"] = ok;
  doc["message"] = message;
  String out;
  serializeJson(doc, out);
  server.send(code, "application/json", out);
}

void handleCommand() {
  JsonDocument body;
  if (deserializeJson(body, server.arg("plain"))) return reply(400, false, "Invalid JSON");
  String type = body["type"] | "";

  if (type == "identify") {
    identifyUntil = millis() + 10000;
    return reply(200, true, "Blinking LED for 10 seconds.");
  }
  if (type == "set_fan_speed" && isKind("ventilation_fan")) {
    fanSpeed = constrain((int)(body["speed"] | 0), 0, 100);
    applyOutputs();
    return reply(200, true, "Fan set to " + String(fanSpeed) + "%.");
  }
  if (type == "set_relay" && isKind("relay")) {
    relayOn = body["on"] | false;
    applyOutputs();
    return reply(200, true, String("Relay ") + (relayOn ? "ON" : "OFF") + ".");
  }
  if (type == "set_purifier_mode" && isKind("air_purifier")) {
    String mode = body["mode"] | "off";
    if (mode != "off" && mode != "auto" && mode != "low" && mode != "medium" && mode != "high")
      return reply(400, false, "Unknown mode.");
    purifierMode = mode;
    applyOutputs();
    return reply(200, true, "Purifier set to " + purifierMode + ".");
  }
  reply(400, false, "Command '" + type + "' is not supported by a " + String(DEVICE_KIND) + ".");
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  pinMode(RELAY_PIN, OUTPUT);
  pinMode(FAN_PWM_PIN, OUTPUT);
  applyOutputs();

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("Connecting to Wi-Fi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
    Serial.print(".");
  }
  Serial.printf("\nReady: http://%s/status\n", WiFi.localIP().toString().c_str());

  server.on("/status", HTTP_GET, handleStatus);
  server.on("/command", HTTP_POST, handleCommand);
  server.onNotFound([]() { reply(404, false, "Not found"); });
  server.begin();
}

void loop() {
  server.handleClient();
  // Identify: blink the LED.
  digitalWrite(LED_PIN, millis() < identifyUntil ? (millis() / 250) % 2 : LOW);
}
