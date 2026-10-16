SET FOREIGN_KEY_CHECKS = 0;

UPDATE plants.sensors_measurements
SET id_sensors = CASE id_sensors
  WHEN 5 THEN 2
  WHEN 6 THEN 3
  WHEN 7 THEN 4
  WHEN 9 THEN 5
  ELSE id_sensors
END
WHERE id_sensors IN (5, 6, 7, 9);

UPDATE plants.sensor_error
SET id_sensor_number = CASE id_sensor_number
  WHEN 5 THEN 2
  WHEN 6 THEN 3
  WHEN 7 THEN 4
  WHEN 9 THEN 5
  ELSE id_sensor_number
END
WHERE id_sensor_number IN (5, 6, 7, 9);

UPDATE plants.stage_equipment
SET id_sensor = CASE id_sensor
  WHEN 5 THEN 2
  WHEN 6 THEN 3
  WHEN 7 THEN 4
  WHEN 9 THEN 5
  ELSE id_sensor
END
WHERE id_sensor IN (5, 6, 7, 9);

UPDATE plants.sensors
SET id_sensor = CASE id_sensor
  WHEN 5 THEN 2
  WHEN 6 THEN 3
  WHEN 7 THEN 4
  WHEN 9 THEN 5
  ELSE id_sensor
END
WHERE id_sensor IN (5, 6, 7, 9);

SET FOREIGN_KEY_CHECKS = 1;
