DROP PROCEDURE IF EXISTS plants.start_irrigation_for_zone;

DELIMITER $$

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
  DECLARE v_hydro_ph_sensor INT DEFAULT NULL;
  DECLARE v_hydro_ec_sensor INT DEFAULT NULL;
  DECLARE v_aero_root_sensor INT DEFAULT NULL;
  DECLARE v_aero_ec_sensor INT DEFAULT NULL;
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
    SELECT id_sensor INTO v_hydro_ph_sensor
    FROM plants.sensors
    WHERE id_parameterss = 4
    ORDER BY id_sensor
    LIMIT 1;

    SELECT id_sensor INTO v_hydro_ec_sensor
    FROM plants.sensors
    WHERE id_parameterss = 6
    ORDER BY id_sensor
    LIMIT 1;

    IF v_hydro_ph_sensor IS NOT NULL OR v_hydro_ec_sensor IS NOT NULL THEN
      SET v_minutes = GREATEST(1, FLOOR(v_duration_sec / 60));
      SET v_i = 0;
      SET v_hydro_ph = ROUND(6.0 + (RAND() - 0.5) * 0.2, 2);
      SET v_hydro_ec = ROUND(1.9 + (RAND() - 0.5) * 0.2, 2);

      WHILE v_i < v_minutes DO
        IF v_hydro_ph_sensor IS NOT NULL THEN
          INSERT INTO plants.sensors_measurements
            (id_sensors, id_parameter, value, id_zone, id_run, `timestamp`)
          VALUES
            (v_hydro_ph_sensor, 4, v_hydro_ph, p_id_zone, v_run_id, DATE_ADD(v_started_at, INTERVAL v_i MINUTE));
          SET v_hydro_ph = ROUND(LEAST(6.2, GREATEST(5.8, v_hydro_ph + (RAND() - 0.5) * 0.08)), 2);
        END IF;

        IF v_hydro_ec_sensor IS NOT NULL THEN
          INSERT INTO plants.sensors_measurements
            (id_sensors, id_parameter, value, id_zone, id_run, `timestamp`)
          VALUES
            (v_hydro_ec_sensor, 6, v_hydro_ec, p_id_zone, v_run_id, DATE_ADD(v_started_at, INTERVAL v_i MINUTE));
          SET v_hydro_ec = ROUND(LEAST(2.2, GREATEST(1.6, v_hydro_ec + (RAND() - 0.5) * 0.12)), 2);
        END IF;

        SET v_i = v_i + 1;
      END WHILE;
    END IF;

    IF p_trigger_type = 'MANUAL' THEN
      CALL plants.start_hydro_a2_ndvi_recovery(p_id_zone, v_started_at);
    END IF;

  ELSEIF v_id_technolog = 2 THEN
    SELECT id_sensor INTO v_aero_root_sensor
    FROM plants.sensors
    WHERE id_parameterss = 7
    ORDER BY id_sensor
    LIMIT 1;

    SELECT id_sensor INTO v_aero_ec_sensor
    FROM plants.sensors
    WHERE id_parameterss = 6
    ORDER BY id_sensor
    LIMIT 1;

    IF v_aero_root_sensor IS NOT NULL OR v_aero_ec_sensor IS NOT NULL THEN
      SET v_seconds = GREATEST(1, v_duration_sec);
      SET v_i = 0;
      SET v_aero_ec = ROUND(1.9 + (RAND() - 0.5) * 0.2, 2);

      WHILE v_i < v_seconds DO
        IF v_aero_root_sensor IS NOT NULL THEN
          INSERT INTO plants.sensors_measurements
            (id_sensors, id_parameter, value, id_zone, id_run, `timestamp`)
          VALUES
            (v_aero_root_sensor, 7, ROUND(95 + RAND() * 5, 0), p_id_zone, v_run_id, DATE_ADD(v_started_at, INTERVAL v_i SECOND));
        END IF;

        IF v_aero_ec_sensor IS NOT NULL THEN
          INSERT INTO plants.sensors_measurements
            (id_sensors, id_parameter, value, id_zone, id_run, `timestamp`)
          VALUES
            (v_aero_ec_sensor, 6, v_aero_ec, p_id_zone, v_run_id, DATE_ADD(v_started_at, INTERVAL v_i SECOND));
          SET v_aero_ec = ROUND(LEAST(2.2, GREATEST(1.6, v_aero_ec + (RAND() - 0.5) * 0.1)), 2);
        END IF;

        SET v_i = v_i + 1;
      END WHILE;
    END IF;
  END IF;

  SELECT v_run_id AS id_run;
END$$

DELIMITER ;
