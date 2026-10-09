/*
 * ESP32 MQTT firmware for iot-mcp-server (DEVICE_ADAPTER=mqtt).
 *
 * Topics (prefix "iot", device id below):
 *   publishes  iot/<id>/status   JSON status every STATUS_EVERY_MS (retained)
 *   publishes  iot/<id>/online   "true" on connect; Last Will "false" if the device drops off
 *   subscribes iot/<id>/command  {"requestId":"…","type":"set_fan_speed","speed":60}
 *   publishes  iot/<id>/ack      {"requestId":"…","ok":true,"message":"…"}
 *
 * Point MQTT_HOST at your broker — or at the iot-mcp-server machine when it runs
 * with MQTT_EMBEDDED_BROKER=true. Sensor reads are stubs: swap in your drivers.
 *
 * Libraries: PubSubClient, ArduinoJson (v7). Board: any ESP32 (Arduino core 3.x).
 */
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

// ---------- configure me ----------
const char* WIFI_SSID = "YOUR_WIFI";
const char* WIFI_PASS = "YOUR_PASSWORD";
const char* MQTT_HOST = "192.168.1.10";
const uint16_t MQTT_PORT = 1883;
const char* MQTT_USER = "";            // leave empty if your broker has no auth
const char* MQTT_PASS = "";
const char* DEVICE_ID = "aq-conf-01";
const char* DEVICE_NAME = "SafeAir Monitor";
const char* DEVICE_ROOM = "Conference Room A";
// One of: air_monitor | ventilation_fan | air_purifier | relay
const char* DEVICE_KIND = "air_monitor";
const char* FIRMWARE = "1.0.0";
const unsigned long STATUS_EVERY_MS = 5000;

const int LED_PIN = 2;
const int FAN_PWM_PIN = 25;
const int RELAY_PIN = 26;
// ----------------------------------

WiFiClient net;
PubSubClient mqtt(net);
String topicStatus, topicOnline, topicCommand, topicAck;

int fanSpeed = 0;
bool relayOn = false;
String purifierMode = "off";
unsigned long identifyUntil = 0;
unsigned long lastStatus = 0;

// TODO: replace with real sensor drivers (SCD40, PMS5003/SPS30, SGP40, SHT4x…).
float readCO2()         { return 600 + random(-30, 30); }
float readPM25()        { return 12.0 + random(-20, 20) / 10.0; }
float readTVOC()        { return 150 + random(-20, 20); }
float readTemperature() { return 24.0 + random(-5, 5) / 10.0; }
float readHumidity()    { return 52.0 + random(-10, 10) / 10.0; }

bool isKind(const char* k) { return strcmp(DEVICE_KIND, k) == 0; }

void applyOutputs() {
  analogWrite(FAN_PWM_PIN, map(fanSpeed, 0, 100, 0, 255));
  bool power = isKind("relay") ? relayOn : (isKind("air_purifier") ? purifierMode != "off" : false);
  digitalWrite(RELAY_PIN, power ? HIGH : LOW);
}

void publishStatus() {
  JsonDocument doc;
  doc["name"] = DEVICE_NAME;
  doc["kind"] = DEVICE_KIND;
  doc["room"] = DEVICE_ROOM;
  doc["firmware"] = FIRMWARE;
  JsonObject readings = doc["readings"].to<JsonObject>();
  readings["rssi"] = WiFi.RSSI();
  if (isKind("air_monitor")) {
    float pm = readPM25();
    readings["co2"] = (int)readCO2();
    readings["pm25"] = round(pm * 10) / 10.0;
    readings["pm10"] = round(pm * 14) / 10.0;
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
  if (millis() < identifyUntil) meta["identifyUntil"] = identifyUntil;

  char buf[768];
  size_t n = serializeJson(doc, buf);
  mqtt.publish(topicStatus.c_str(), (const uint8_t*)buf, n, true);
}

void ack(const char* requestId, bool ok, const String& message) {
  JsonDocument doc;
  doc["requestId"] = requestId;
  doc["ok"] = ok;
  doc["message"] = message;
  char buf[256];
  size_t n = serializeJson(doc, buf);
  mqtt.publish(topicAck.c_str(), (const uint8_t*)buf, n);
}

void onMessage(char* topic, byte* payload, unsigned int length) {
  JsonDocument cmd;
  if (deserializeJson(cmd, payload, length)) return;
  const char* requestId = cmd["requestId"] | "";
  String type = cmd["type"] | "";

  if (type == "identify") {
    identifyUntil = millis() + 10000;
    ack(requestId, true, "Blinking LED for 10 seconds.");
  } else if (type == "set_fan_speed" && isKind("ventilation_fan")) {
    fanSpeed = constrain((int)(cmd["speed"] | 0), 0, 100);
    applyOutputs();
    ack(requestId, true, "Fan set to " + String(fanSpeed) + "%.");
  } else if (type == "set_relay" && isKind("relay")) {
    relayOn = cmd["on"] | false;
    applyOutputs();
    ack(requestId, true, String("Relay ") + (relayOn ? "ON" : "OFF") + ".");
  } else if (type == "set_purifier_mode" && isKind("air_purifier")) {
    purifierMode = String(cmd["mode"] | "off");
    applyOutputs();
    ack(requestId, true, "Purifier set to " + purifierMode + ".");
  } else {
    ack(requestId, false, "Command '" + type + "' is not supported by a " + String(DEVICE_KIND) + ".");
    return;
  }
  publishStatus(); // report the new state right away
}

void connectMqtt() {
  while (!mqtt.connected()) {
    Serial.print("MQTT connecting… ");
    // Last Will: broker publishes "false" to iot/<id>/online if we drop off.
    bool ok = strlen(MQTT_USER)
      ? mqtt.connect(DEVICE_ID, MQTT_USER, MQTT_PASS, topicOnline.c_str(), 1, true, "false")
      : mqtt.connect(DEVICE_ID, topicOnline.c_str(), 1, true, "false");
    if (ok) {
      Serial.println("connected");
      mqtt.publish(topicOnline.c_str(), "true", true);
      mqtt.subscribe(topicCommand.c_str(), 1);
      publishStatus();
    } else {
      Serial.printf("failed (%d), retrying in 3s\n", mqtt.state());
      delay(3000);
    }
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  pinMode(RELAY_PIN, OUTPUT);
  pinMode(FAN_PWM_PIN, OUTPUT);
  applyOutputs();

  String base = String("iot/") + DEVICE_ID;
  topicStatus = base + "/status";
  topicOnline = base + "/online";
  topicCommand = base + "/command";
  topicAck = base + "/ack";

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) delay(400);
  Serial.printf("Wi-Fi OK: %s\n", WiFi.localIP().toString().c_str());

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setBufferSize(1024);
  mqtt.setCallback(onMessage);
}

void loop() {
  if (!mqtt.connected()) connectMqtt();
  mqtt.loop();
  if (millis() - lastStatus > STATUS_EVERY_MS) {
    lastStatus = millis();
    publishStatus();
  }
  digitalWrite(LED_PIN, millis() < identifyUntil ? (millis() / 250) % 2 : LOW);
}
