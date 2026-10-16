DELETE FROM plants.sensors_measurements
WHERE id_sensors IN (
  SELECT id_sensor
  FROM plants.sensors
  WHERE id_parameterss IN (4, 6, 7, 9)
);

DELETE se
FROM plants.sensor_error se
JOIN plants.sensors s ON s.id_sensor = se.id_sensor_number
WHERE s.id_parameterss IN (4, 6, 7, 9);

DELETE se
FROM plants.stage_equipment se
JOIN plants.sensors s ON s.id_sensor = se.id_sensor
WHERE s.id_parameterss IN (4, 6, 7, 9);

DELETE FROM plants.reference_values
WHERE id_parameters IN (4, 6, 7, 9);

DELETE FROM plants.sensors
WHERE id_parameterss IN (4, 6, 7, 9);

DELETE FROM plants.parameters
WHERE id_parameter IN (4, 6, 7, 9);
