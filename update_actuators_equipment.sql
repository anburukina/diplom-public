UPDATE plants.actuators
SET actuators_serial_number = 'BALLU-BFH-S10',
    name_actuator = 'Ballu BFH-S10',
    type_actuators = 'Тепловентилятор'
WHERE id_actuator = 1;

UPDATE plants.actuators
SET actuators_serial_number = 'DAIKIN-FTXM35R',
    name_actuator = 'Daikin FTXM35R',
    type_actuators = 'Кондиционер'
WHERE id_actuator = 2;

UPDATE plants.actuators
SET actuators_serial_number = 'TROTEC-TTK-350-S',
    name_actuator = 'Trotec TTK 350 S',
    type_actuators = 'Осушитель воздуха'
WHERE id_actuator = 3;

UPDATE plants.actuators
SET actuators_serial_number = 'DANFOSS-EV220B',
    name_actuator = 'Danfoss EV220B',
    type_actuators = 'Электромагнитный клапан подачи CO2'
WHERE id_actuator = 4;

INSERT INTO plants.actuators
  (id_actuator, actuators_serial_number, name_actuator, type_actuators)
VALUES
  (5, 'ROVDC-5-2026-001', 'Reef Octopus Varios-4 DC Pump', 'Насос подачи раствора'),
  (7, 'ASCO-238610-2026-001', 'ASCO 238610 Series Solenoid Valve', 'Электромагнитный клапан подачи раствора'),
  (8, 'HAOPAI-24V-UMK-2026-001', 'HaoPai 24V Ultrasonic Mist Maker', 'Ультразвуковой распылитель аэропонной системы'),
  (9, 'PURITY-PZ-50-125-40-2026-001', 'Purity PZ 50-125/40', 'Дренажный насос')
ON DUPLICATE KEY UPDATE
  actuators_serial_number = VALUES(actuators_serial_number),
  name_actuator = VALUES(name_actuator),
  type_actuators = VALUES(type_actuators);

DELETE FROM plants.actuators
WHERE id_actuator NOT IN (1, 2, 3, 4, 5, 7, 8, 9);
