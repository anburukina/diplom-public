DROP EVENT IF EXISTS plants.generate_aero_root_humidity;
DROP EVENT IF EXISTS plants.insert_fake_measurements;

DELIMITER $$

CREATE DEFINER=`root`@`localhost` EVENT `plants`.`insert_fake_measurements`
ON SCHEDULE EVERY 2 SECOND
STARTS CURRENT_TIMESTAMP + INTERVAL 2 SECOND
ON COMPLETION NOT PRESERVE
ENABLE
DO
BEGIN
  DECLARE v_temp DOUBLE DEFAULT 23;
  DECLARE v_humidity DOUBLE DEFAULT 75;
  DECLARE v_co2 DOUBLE DEFAULT 1250;

  SELECT value INTO v_temp
  FROM plants.sensors_measurements
  WHERE id_parameter = 1
  ORDER BY `timestamp` DESC
  LIMIT 1;

  SELECT value INTO v_humidity
  FROM plants.sensors_measurements
  WHERE id_parameter = 2
  ORDER BY `timestamp` DESC
  LIMIT 1;

  SELECT value INTO v_co2
  FROM plants.sensors_measurements
  WHERE id_parameter = 3
  ORDER BY `timestamp` DESC
  LIMIT 1;

  SET v_temp = LEAST(25, GREATEST(22, IFNULL(v_temp, 23.5) + (23.5 - IFNULL(v_temp, 23.5)) * 0.03 + (RAND() - 0.5) * 0.16));
  SET v_humidity = LEAST(80, GREATEST(70, IFNULL(v_humidity, 75) + (75 - IFNULL(v_humidity, 75)) * 0.04 + (RAND() - 0.5) * 0.9));
  SET v_co2 = LEAST(1500, GREATEST(1000, IFNULL(v_co2, 1250) + (1250 - IFNULL(v_co2, 1250)) * 0.03 + (RAND() - 0.5) * 24));

  INSERT INTO plants.sensors_measurements (id_sensors, id_parameter, value, id_zone)
  VALUES
    ((SELECT id_sensor FROM plants.sensors WHERE id_parameterss = 1 ORDER BY id_sensor LIMIT 1), 1, ROUND(v_temp, 1), NULL),
    ((SELECT id_sensor FROM plants.sensors WHERE id_parameterss = 2 ORDER BY id_sensor LIMIT 1), 2, ROUND(v_humidity, 1), NULL),
    ((SELECT id_sensor FROM plants.sensors WHERE id_parameterss = 3 ORDER BY id_sensor LIMIT 1), 3, ROUND(v_co2, 0), NULL);
END$$

DROP PROCEDURE IF EXISTS plants.start_irrigation_for_zone$$
CREATE DEFINER=`root`@`localhost` PROCEDURE `plants`.`start_irrigation_for_zone`(
  IN p_id_zone INT,
  IN p_trigger_type ENUM('SCHEDULED','MANUAL'),
  IN p_duration_sec INT,
  IN p_started_by_employee INT
)
BEGIN
  DECLARE v_id_technolog INT;
  DECLARE v_run_id BIGINT UNSIGNED;
  DECLARE v_started_at DATETIME;
  DECLARE v_duration_sec INT;

  SELECT id_technolog INTO v_id_technolog
  FROM plants.zones
  WHERE id_zone = p_id_zone
  LIMIT 1;

  IF v_id_technolog IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Zone not found or id_technolog is NULL';
  END IF;

  SET v_started_at = NOW();
  SET v_duration_sec = CASE
    WHEN v_id_technolog = 1 THEN GREATEST(60, IFNULL(p_duration_sec, 600))
    WHEN v_id_technolog = 2 THEN GREATEST(1, IFNULL(p_duration_sec, 10))
    ELSE GREATEST(1, IFNULL(p_duration_sec, 60))
  END;

  INSERT INTO plants.irrigation_runs (id_zone, trigger_type, started_by_employee, started_at, duration_sec)
  VALUES (p_id_zone, p_trigger_type, p_started_by_employee, v_started_at, v_duration_sec);

  SET v_run_id = LAST_INSERT_ID();

  SELECT v_run_id AS id_run;
END$$

DELIMITER ;

DELETE se
FROM plants.sensor_error se
JOIN plants.sensors s ON s.id_sensor = se.id_sensor_number
WHERE s.id_parameterss IN (4, 6, 7, 9);

DELETE FROM plants.sensor_error
WHERE error_code IN ('OUT-4', 'OUT-6', 'OUT-7', 'OUT-9');

DELETE se
FROM plants.stage_equipment se
JOIN plants.sensors s ON s.id_sensor = se.id_sensor
WHERE s.id_parameterss IN (4, 6, 7, 9);

DELETE FROM plants.sensors_measurements
WHERE id_parameter IN (4, 6, 7, 9);

DELETE FROM plants.sensors_measurements
WHERE id_sensors IN (
  SELECT id_sensor
  FROM plants.sensors
  WHERE id_parameterss IN (4, 6, 7, 9)
);

DELETE FROM plants.reference_values
WHERE id_parameters IN (4, 6, 7, 9);

DELETE FROM plants.sensors
WHERE id_parameterss IN (4, 6, 7, 9);

DELETE FROM plants.parameters
WHERE id_parameter IN (4, 6, 7, 9);
