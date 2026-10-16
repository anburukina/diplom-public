INSERT INTO plants.sensors
  (id_sensor, sensor_serial_number, name_sensor, min_value, max_value, id_units, id_parameterss)
VALUES
  (6, 'AQ150-PH-2026-001', 'Промышленный контроллер pH', 0, 14, 5, 4),
  (7, 'AQEC150-RS485-2026-001', 'Промышленный кондуктометр', 0.05, 200, 6, 6),
  (8, 'EE310-RH-2026-001', 'Высококачественный датчик влажности и температуры', 0, 100, 1, 7)
ON DUPLICATE KEY UPDATE
  sensor_serial_number = VALUES(sensor_serial_number),
  name_sensor = VALUES(name_sensor),
  min_value = VALUES(min_value),
  max_value = VALUES(max_value),
  id_units = VALUES(id_units),
  id_parameterss = VALUES(id_parameterss);
