SET GLOBAL event_scheduler = ON;

CREATE TABLE IF NOT EXISTS plants.ndvi (
  id_ndvi BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  id_zone INT NOT NULL,
  ndvi_value DOUBLE NOT NULL,
  `timestamp` DATETIME NOT NULL,
  INDEX idx_ndvi_zone_timestamp (id_zone, `timestamp`)
);

CREATE TABLE IF NOT EXISTS plants.ndvi_scenario_state (
  scenario_name VARCHAR(64) PRIMARY KEY,
  id_zone INT NULL,
  phase ENUM('DECLINE','RECOVERY','NORMAL') NOT NULL DEFAULT 'DECLINE',
  step_index INT NOT NULL DEFAULT 0,
  started_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL
);

DROP PROCEDURE IF EXISTS plants.write_hydro_a2_ndvi_value;
DROP PROCEDURE IF EXISTS plants.start_hydro_a2_ndvi_decline_scenario;
DROP PROCEDURE IF EXISTS plants.generate_hydro_a2_ndvi_tick;
DROP PROCEDURE IF EXISTS plants.start_hydro_a2_ndvi_recovery;
DROP EVENT IF EXISTS plants.generate_hydro_a2_ndvi_event;

DELIMITER $$

CREATE PROCEDURE plants.write_hydro_a2_ndvi_value(
  IN p_id_zone INT,
  IN p_value DECIMAL(6,3),
  IN p_ts DATETIME
)
BEGIN
  DECLARE v_sensor_id INT DEFAULT NULL;
  DECLARE v_min DOUBLE DEFAULT 0.5;
  DECLARE v_max DOUBLE DEFAULT 0.75;
  DECLARE v_error_exists INT DEFAULT 0;

  SELECT id_sensor INTO v_sensor_id
  FROM plants.sensors
  WHERE id_parameterss = 10
  ORDER BY id_sensor
  LIMIT 1;

  SELECT COALESCE(min_value, v_min), COALESCE(max_value, v_max)
    INTO v_min, v_max
  FROM plants.reference_values
  WHERE id_parameters = 10
  LIMIT 1;

  IF v_sensor_id IS NOT NULL THEN
    DELETE FROM plants.sensors_measurements
    WHERE id_parameter = 10
      AND id_zone = p_id_zone
      AND `timestamp` = p_ts;

    INSERT INTO plants.sensors_measurements
      (id_sensors, id_parameter, value, id_zone, id_run, `timestamp`)
    VALUES
      (v_sensor_id, 10, p_value, p_id_zone, NULL, p_ts);

    DELETE FROM plants.ndvi
    WHERE id_zone = p_id_zone
      AND `timestamp` = p_ts;

    INSERT INTO plants.ndvi (id_zone, ndvi_value, `timestamp`)
    VALUES (p_id_zone, p_value, p_ts);

    IF p_value < v_min OR p_value > v_max THEN
      SELECT COUNT(*) INTO v_error_exists
      FROM plants.sensor_error
      WHERE id_sensor_number = v_sensor_id
        AND error_code = 'OUT-10'
        AND `timestamp` = p_ts;

      IF v_error_exists = 0 THEN
        INSERT INTO plants.sensor_error
          (error_code, error_name, `timestamp`, id_sensor_number)
        VALUES
          ('OUT-10', 'NDVI для зоны A2 низкое', p_ts, v_sensor_id);
      END IF;
    END IF;
  END IF;
END$$

CREATE PROCEDURE plants.start_hydro_a2_ndvi_decline_scenario()
BEGIN
  DECLARE v_zone_id INT DEFAULT NULL;
  DECLARE v_sensor_id INT DEFAULT NULL;
  DECLARE v_now_hour DATETIME;
  DECLARE v_start DATETIME;
  DECLARE v_value DECIMAL(6,3);
  DECLARE v_i INT DEFAULT 0;

  SELECT id_zone INTO v_zone_id
  FROM plants.zones
  WHERE id_technolog = 1
    AND (LOWER(zone_name) LIKE '%a2%' OR LOWER(zone_name) LIKE '%а2%')
  ORDER BY id_zone
  LIMIT 1;

  IF v_zone_id IS NOT NULL THEN
    SELECT id_sensor INTO v_sensor_id
    FROM plants.sensors
    WHERE id_parameterss = 10
    ORDER BY id_sensor
    LIMIT 1;

    SET v_now_hour = TIMESTAMP(DATE_FORMAT(NOW(), '%Y-%m-%d %H:00:00'));
    SET v_start = DATE_SUB(v_now_hour, INTERVAL 23 HOUR);

    DELETE FROM plants.sensors_measurements
    WHERE id_parameter = 10
      AND id_zone = v_zone_id
      AND `timestamp` BETWEEN v_start AND v_now_hour;

    DELETE FROM plants.ndvi
    WHERE id_zone = v_zone_id
      AND `timestamp` BETWEEN v_start AND v_now_hour;

    IF v_sensor_id IS NOT NULL THEN
      DELETE FROM plants.sensor_error
      WHERE id_sensor_number = v_sensor_id
        AND error_code = 'OUT-10'
        AND `timestamp` BETWEEN v_start AND v_now_hour;
    END IF;

    WHILE v_i < 24 DO
      SET v_value = ROUND(0.620 - ((0.620 - 0.450) * v_i / 23), 3);
      CALL plants.write_hydro_a2_ndvi_value(
        v_zone_id,
        v_value,
        DATE_ADD(v_start, INTERVAL v_i HOUR)
      );
      SET v_i = v_i + 1;
    END WHILE;

    INSERT INTO plants.ndvi_scenario_state
      (scenario_name, id_zone, phase, step_index, started_at, updated_at)
    VALUES
      ('hydro_a2_ndvi', v_zone_id, 'DECLINE', 23, v_start, NOW())
    ON DUPLICATE KEY UPDATE
      id_zone = VALUES(id_zone),
      phase = VALUES(phase),
      step_index = VALUES(step_index),
      started_at = VALUES(started_at),
      updated_at = VALUES(updated_at);
  END IF;
END$$

CREATE PROCEDURE plants.generate_hydro_a2_ndvi_tick()
BEGIN
  DECLARE v_zone_id INT DEFAULT NULL;
  DECLARE v_phase VARCHAR(16) DEFAULT NULL;
  DECLARE v_step INT DEFAULT 0;
  DECLARE v_ts DATETIME;
  DECLARE v_value DECIMAL(6,3);

  SELECT id_zone, phase, step_index
    INTO v_zone_id, v_phase, v_step
  FROM plants.ndvi_scenario_state
  WHERE scenario_name = 'hydro_a2_ndvi'
  LIMIT 1;

  IF v_zone_id IS NOT NULL THEN
    SET v_ts = TIMESTAMP(DATE_FORMAT(NOW(), '%Y-%m-%d %H:00:00'));

    IF v_phase = 'RECOVERY' THEN
      SET v_value = ROUND(0.450 + ((0.620 - 0.450) * LEAST(v_step, 23) / 23), 3);
      CALL plants.write_hydro_a2_ndvi_value(v_zone_id, v_value, v_ts);

      UPDATE plants.ndvi_scenario_state
      SET step_index = CASE WHEN v_step >= 23 THEN 23 ELSE v_step + 1 END,
          phase = CASE WHEN v_step >= 23 THEN 'NORMAL' ELSE 'RECOVERY' END,
          updated_at = NOW()
      WHERE scenario_name = 'hydro_a2_ndvi';

    ELSEIF v_phase = 'DECLINE' THEN
      SET v_value = ROUND(0.620 - ((0.620 - 0.450) * LEAST(v_step, 23) / 23), 3);
      CALL plants.write_hydro_a2_ndvi_value(v_zone_id, v_value, v_ts);

      UPDATE plants.ndvi_scenario_state
      SET step_index = CASE WHEN v_step >= 23 THEN 23 ELSE v_step + 1 END,
          updated_at = NOW()
      WHERE scenario_name = 'hydro_a2_ndvi';
    END IF;
  END IF;
END$$

CREATE PROCEDURE plants.start_hydro_a2_ndvi_recovery(
  IN p_id_zone INT,
  IN p_started_at DATETIME
)
BEGIN
  DECLARE v_id_technolog INT DEFAULT NULL;
  DECLARE v_zone_name VARCHAR(255) DEFAULT NULL;

  SELECT id_technolog, zone_name
    INTO v_id_technolog, v_zone_name
  FROM plants.zones
  WHERE id_zone = p_id_zone
  LIMIT 1;

  IF v_id_technolog = 1
     AND (LOWER(v_zone_name) LIKE '%a2%' OR LOWER(v_zone_name) LIKE '%а2%') THEN
    INSERT INTO plants.ndvi_scenario_state
      (scenario_name, id_zone, phase, step_index, started_at, updated_at)
    VALUES
      ('hydro_a2_ndvi', p_id_zone, 'RECOVERY', 0, p_started_at, NOW())
    ON DUPLICATE KEY UPDATE
      id_zone = VALUES(id_zone),
      phase = VALUES(phase),
      step_index = VALUES(step_index),
      started_at = VALUES(started_at),
      updated_at = VALUES(updated_at);

    CALL plants.generate_hydro_a2_ndvi_tick();
  END IF;
END$$

CREATE DEFINER=`root`@`localhost` EVENT plants.generate_hydro_a2_ndvi_event
ON SCHEDULE EVERY 1 HOUR
STARTS CURRENT_TIMESTAMP + INTERVAL 1 HOUR
ON COMPLETION NOT PRESERVE
ENABLE
DO
BEGIN
  CALL plants.generate_hydro_a2_ndvi_tick();
END$$

DROP PROCEDURE IF EXISTS plants.start_irrigation_for_zone$$
CREATE DEFINER=`root`@`localhost` PROCEDURE plants.start_irrigation_for_zone(
  IN p_id_zone INT,
  IN p_trigger_type ENUM('SCHEDULED','MANUAL'),
  IN p_duration_sec INT,
  IN p_started_by_employee INT
)
BEGIN
  DECLARE v_id_technolog INT;
  DECLARE v_run_id BIGINT UNSIGNED;
  DECLARE v_started_at DATETIME;
  DECLARE v_minutes INT;
  DECLARE v_seconds INT;
  DECLARE v_duration_sec INT;
  DECLARE v_i INT DEFAULT 0;
  DECLARE v_hydro_ph DOUBLE DEFAULT 6.0;
  DECLARE v_hydro_ec DOUBLE DEFAULT 0;
  DECLARE v_aero_ec DOUBLE DEFAULT 0;

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

  INSERT INTO plants.irrigation_runs
    (id_zone, trigger_type, started_by_employee, started_at, duration_sec)
  VALUES
    (p_id_zone, p_trigger_type, p_started_by_employee, v_started_at, v_duration_sec);

  SET v_run_id = LAST_INSERT_ID();

  IF v_id_technolog = 1 THEN
    SET v_minutes = GREATEST(1, FLOOR(v_duration_sec / 60));
    SET v_i = 0;
    SET v_hydro_ph = ROUND(6.0 + (RAND() - 0.5) * 0.2, 2);
    SET v_hydro_ec = ROUND(1.9 + (RAND() - 0.5) * 0.2, 2);

    WHILE v_i < v_minutes DO
      INSERT INTO plants.sensors_measurements
        (id_sensors, id_parameter, value, id_zone, id_run, `timestamp`)
      VALUES
        ((SELECT id_sensor FROM plants.sensors WHERE id_parameterss = 4 ORDER BY id_sensor LIMIT 1), 4, v_hydro_ph, p_id_zone, v_run_id, DATE_ADD(v_started_at, INTERVAL v_i MINUTE)),
        ((SELECT id_sensor FROM plants.sensors WHERE id_parameterss = 6 ORDER BY id_sensor LIMIT 1), 6, v_hydro_ec, p_id_zone, v_run_id, DATE_ADD(v_started_at, INTERVAL v_i MINUTE));
      SET v_hydro_ph = ROUND(LEAST(6.2, GREATEST(5.8, v_hydro_ph + (RAND() - 0.5) * 0.08)), 2);
      SET v_hydro_ec = ROUND(LEAST(2.2, GREATEST(1.6, v_hydro_ec + (RAND() - 0.5) * 0.12)), 2);
      SET v_i = v_i + 1;
    END WHILE;

    IF p_trigger_type = 'MANUAL' THEN
      CALL plants.start_hydro_a2_ndvi_recovery(p_id_zone, v_started_at);
    END IF;

  ELSEIF v_id_technolog = 2 THEN
    SET v_seconds = GREATEST(1, v_duration_sec);
    SET v_i = 0;
    SET v_aero_ec = ROUND(1.9 + (RAND() - 0.5) * 0.2, 2);

    WHILE v_i < v_seconds DO
      INSERT INTO plants.sensors_measurements
        (id_sensors, id_parameter, value, id_zone, id_run, `timestamp`)
      VALUES
        ((SELECT id_sensor FROM plants.sensors WHERE id_parameterss = 7 ORDER BY id_sensor LIMIT 1), 7, ROUND(95 + RAND() * 5, 0), p_id_zone, v_run_id, DATE_ADD(v_started_at, INTERVAL v_i SECOND)),
        ((SELECT id_sensor FROM plants.sensors WHERE id_parameterss = 6 ORDER BY id_sensor LIMIT 1), 6, v_aero_ec, p_id_zone, v_run_id, DATE_ADD(v_started_at, INTERVAL v_i SECOND));
      SET v_aero_ec = ROUND(LEAST(2.2, GREATEST(1.6, v_aero_ec + (RAND() - 0.5) * 0.1)), 2);
      SET v_i = v_i + 1;
    END WHILE;
  END IF;

  SELECT v_run_id AS id_run;
END$$

DELIMITER ;

-- Start the A2 decline scenario when needed:
-- CALL plants.start_hydro_a2_ndvi_decline_scenario();
