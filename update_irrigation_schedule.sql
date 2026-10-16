SET @add_duration_sec = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE plants.irrigation_runs ADD COLUMN duration_sec INT NULL AFTER started_at',
    'SELECT 1'
  )
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = 'plants'
    AND TABLE_NAME = 'irrigation_runs'
    AND COLUMN_NAME = 'duration_sec'
);
PREPARE add_duration_sec_stmt FROM @add_duration_sec;
EXECUTE add_duration_sec_stmt;
DEALLOCATE PREPARE add_duration_sec_stmt;

DROP PROCEDURE IF EXISTS plants.start_irrigation_for_zone;
DELIMITER $$
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

  INSERT INTO plants.irrigation_runs (id_zone, trigger_type, started_by_employee, started_at, duration_sec)
  VALUES (p_id_zone, p_trigger_type, p_started_by_employee, v_started_at, v_duration_sec);

  SET v_run_id = LAST_INSERT_ID();

  IF v_id_technolog = 1 THEN
    SET v_minutes = GREATEST(1, FLOOR(v_duration_sec / 60));
    SET v_i = 0;
    SET v_hydro_ph = ROUND(6.0 + (RAND() - 0.5) * 0.2, 2);
    SET v_hydro_ec = ROUND(1.9 + (RAND() - 0.5) * 0.2, 2);

    WHILE v_i < v_minutes DO
      INSERT INTO plants.sensors_measurements (id_sensors, id_parameter, value, id_zone, id_run, `timestamp`)
      VALUES
        ((SELECT id_sensor FROM sensors WHERE id_parameterss = 4 ORDER BY id_sensor LIMIT 1), 4, v_hydro_ph, p_id_zone, v_run_id, DATE_ADD(v_started_at, INTERVAL v_i MINUTE)),
        ((SELECT id_sensor FROM sensors WHERE id_parameterss = 6 ORDER BY id_sensor LIMIT 1), 6, v_hydro_ec, p_id_zone, v_run_id, DATE_ADD(v_started_at, INTERVAL v_i MINUTE));
      SET v_hydro_ph = ROUND(LEAST(6.2, GREATEST(5.8, v_hydro_ph + (RAND() - 0.5) * 0.08)), 2);
      SET v_hydro_ec = ROUND(LEAST(2.2, GREATEST(1.6, v_hydro_ec + (RAND() - 0.5) * 0.12)), 2);
      SET v_i = v_i + 1;
    END WHILE;

  ELSEIF v_id_technolog = 2 THEN
    SET v_seconds = GREATEST(1, v_duration_sec);
    SET v_i = 0;
    SET v_aero_ec = ROUND(1.9 + (RAND() - 0.5) * 0.2, 2);

    WHILE v_i < v_seconds DO
      INSERT INTO plants.sensors_measurements (id_sensors, id_parameter, value, id_zone, id_run, `timestamp`)
      VALUES
        ((SELECT id_sensor FROM sensors WHERE id_parameterss = 7 ORDER BY id_sensor LIMIT 1), 7, ROUND(95 + RAND() * 5, 0), p_id_zone, v_run_id, DATE_ADD(v_started_at, INTERVAL v_i SECOND)),
        ((SELECT id_sensor FROM sensors WHERE id_parameterss = 6 ORDER BY id_sensor LIMIT 1), 6, v_aero_ec, p_id_zone, v_run_id, DATE_ADD(v_started_at, INTERVAL v_i SECOND));
      SET v_aero_ec = ROUND(LEAST(2.2, GREATEST(1.6, v_aero_ec + (RAND() - 0.5) * 0.1)), 2);
      SET v_i = v_i + 1;
    END WHILE;
  END IF;

  SELECT v_run_id AS id_run;

END$$

DROP EVENT IF EXISTS plants.generate_solution_aero$$
CREATE DEFINER=`root`@`localhost` EVENT `plants`.`generate_solution_aero`
ON SCHEDULE EVERY 15 MINUTE
STARTS '2026-02-13 00:00:00'
ON COMPLETION NOT PRESERVE
ENABLE
DO
BEGIN
  IF MINUTE(NOW()) IN (0, 15, 30, 45) AND SECOND(NOW()) < 2 THEN
    BEGIN
      DECLARE v_zone INT;
      DECLARE v_duration_sec INT;
      DECLARE v_employee INT;
      DECLARE done INT DEFAULT 0;

      DECLARE cur CURSOR FOR
        SELECT z.id_zone,
               10 AS duration_sec,
               s.id_employee
        FROM plants.zones z
        LEFT JOIN plants.irrigation_schedule_settings s
          ON s.id_schedule = (
            SELECT s2.id_schedule
            FROM plants.irrigation_schedule_settings s2
            WHERE s2.id_zone = z.id_zone
            ORDER BY s2.id_schedule DESC
            LIMIT 1
          )
        WHERE z.id_technolog = 2
          AND COALESCE(s.is_enabled, 1) = 1;

      DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1;

      OPEN cur;
      read_loop: LOOP
        FETCH cur INTO v_zone, v_duration_sec, v_employee;
        IF done = 1 THEN
          LEAVE read_loop;
        END IF;

        CALL plants.start_irrigation_for_zone(v_zone, 'SCHEDULED', v_duration_sec, v_employee);
      END LOOP;
      CLOSE cur;
    END;
  END IF;
END$$

DROP EVENT IF EXISTS plants.generate_solution_hydro_06$$
CREATE DEFINER=`root`@`localhost` EVENT `plants`.`generate_solution_hydro_06`
ON SCHEDULE EVERY 1 DAY
STARTS '2026-02-13 06:00:00'
ON COMPLETION NOT PRESERVE
ENABLE
DO
BEGIN
  IF TIME(NOW()) BETWEEN '06:00:00' AND '06:00:02' THEN
    BEGIN
      DECLARE v_zone INT;
      DECLARE v_duration_sec INT;
      DECLARE v_employee INT;
      DECLARE done INT DEFAULT 0;

      DECLARE cur CURSOR FOR
        SELECT z.id_zone,
               600 AS duration_sec,
               s.id_employee
        FROM plants.zones z
        LEFT JOIN plants.irrigation_schedule_settings s
          ON s.id_schedule = (
            SELECT s2.id_schedule
            FROM plants.irrigation_schedule_settings s2
            WHERE s2.id_zone = z.id_zone
            ORDER BY s2.id_schedule DESC
            LIMIT 1
          )
        WHERE z.id_technolog = 1
          AND COALESCE(s.is_enabled, 1) = 1;

      DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1;

      OPEN cur;
      read_loop: LOOP
        FETCH cur INTO v_zone, v_duration_sec, v_employee;
        IF done = 1 THEN
          LEAVE read_loop;
        END IF;

        CALL plants.start_irrigation_for_zone(v_zone, 'SCHEDULED', v_duration_sec, v_employee);
      END LOOP;
      CLOSE cur;
    END;
  END IF;
END$$

DROP EVENT IF EXISTS plants.generate_solution_hydro_10$$
CREATE DEFINER=`root`@`localhost` EVENT `plants`.`generate_solution_hydro_10`
ON SCHEDULE EVERY 1 DAY
STARTS '2026-02-13 10:00:00'
ON COMPLETION NOT PRESERVE
ENABLE
DO
BEGIN
  IF TIME(NOW()) BETWEEN '10:00:00' AND '10:00:02' THEN
    BEGIN
      DECLARE v_zone INT;
      DECLARE v_duration_sec INT;
      DECLARE v_employee INT;
      DECLARE done INT DEFAULT 0;

      DECLARE cur CURSOR FOR
        SELECT z.id_zone,
               600 AS duration_sec,
               s.id_employee
        FROM plants.zones z
        LEFT JOIN plants.irrigation_schedule_settings s
          ON s.id_schedule = (
            SELECT s2.id_schedule
            FROM plants.irrigation_schedule_settings s2
            WHERE s2.id_zone = z.id_zone
            ORDER BY s2.id_schedule DESC
            LIMIT 1
          )
        WHERE z.id_technolog = 1
          AND COALESCE(s.is_enabled, 1) = 1;

      DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1;

      OPEN cur;
      read_loop: LOOP
        FETCH cur INTO v_zone, v_duration_sec, v_employee;
        IF done = 1 THEN
          LEAVE read_loop;
        END IF;

        CALL plants.start_irrigation_for_zone(v_zone, 'SCHEDULED', v_duration_sec, v_employee);
      END LOOP;
      CLOSE cur;
    END;
  END IF;
END$$

DROP EVENT IF EXISTS plants.generate_solution_hydro_14$$
CREATE DEFINER=`root`@`localhost` EVENT `plants`.`generate_solution_hydro_14`
ON SCHEDULE EVERY 1 DAY
STARTS '2026-02-13 14:00:00'
ON COMPLETION NOT PRESERVE
ENABLE
DO
BEGIN
  IF TIME(NOW()) BETWEEN '14:00:00' AND '14:00:02' THEN
    BEGIN
      DECLARE v_zone INT;
      DECLARE v_duration_sec INT;
      DECLARE v_employee INT;
      DECLARE done INT DEFAULT 0;

      DECLARE cur CURSOR FOR
        SELECT z.id_zone,
               600 AS duration_sec,
               s.id_employee
        FROM plants.zones z
        LEFT JOIN plants.irrigation_schedule_settings s
          ON s.id_schedule = (
            SELECT s2.id_schedule
            FROM plants.irrigation_schedule_settings s2
            WHERE s2.id_zone = z.id_zone
            ORDER BY s2.id_schedule DESC
            LIMIT 1
          )
        WHERE z.id_technolog = 1
          AND COALESCE(s.is_enabled, 1) = 1;

      DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1;

      OPEN cur;
      read_loop: LOOP
        FETCH cur INTO v_zone, v_duration_sec, v_employee;
        IF done = 1 THEN
          LEAVE read_loop;
        END IF;

        CALL plants.start_irrigation_for_zone(v_zone, 'SCHEDULED', v_duration_sec, v_employee);
      END LOOP;
      CLOSE cur;
    END;
  END IF;
END$$

DROP EVENT IF EXISTS plants.generate_solution_hydro_18$$
CREATE DEFINER=`root`@`localhost` EVENT `plants`.`generate_solution_hydro_18`
ON SCHEDULE EVERY 1 DAY
STARTS '2026-02-13 18:00:00'
ON COMPLETION NOT PRESERVE
ENABLE
DO
BEGIN
  IF TIME(NOW()) BETWEEN '18:00:00' AND '18:00:02' THEN
    BEGIN
      DECLARE v_zone INT;
      DECLARE v_duration_sec INT;
      DECLARE v_employee INT;
      DECLARE done INT DEFAULT 0;

      DECLARE cur CURSOR FOR
        SELECT z.id_zone,
               600 AS duration_sec,
               s.id_employee
        FROM plants.zones z
        LEFT JOIN plants.irrigation_schedule_settings s
          ON s.id_schedule = (
            SELECT s2.id_schedule
            FROM plants.irrigation_schedule_settings s2
            WHERE s2.id_zone = z.id_zone
            ORDER BY s2.id_schedule DESC
            LIMIT 1
          )
        WHERE z.id_technolog = 1
          AND COALESCE(s.is_enabled, 1) = 1;

      DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1;

      OPEN cur;
      read_loop: LOOP
        FETCH cur INTO v_zone, v_duration_sec, v_employee;
        IF done = 1 THEN
          LEAVE read_loop;
        END IF;

        CALL plants.start_irrigation_for_zone(v_zone, 'SCHEDULED', v_duration_sec, v_employee);
      END LOOP;
      CLOSE cur;
    END;
  END IF;
END$$

DROP EVENT IF EXISTS plants.generate_solution_hydro_22$$
CREATE DEFINER=`root`@`localhost` EVENT `plants`.`generate_solution_hydro_22`
ON SCHEDULE EVERY 1 DAY
STARTS '2026-02-13 22:00:00'
ON COMPLETION NOT PRESERVE
ENABLE
DO
BEGIN
  IF TIME(NOW()) BETWEEN '22:00:00' AND '22:00:02' THEN
    BEGIN
      DECLARE v_zone INT;
      DECLARE v_duration_sec INT;
      DECLARE v_employee INT;
      DECLARE done INT DEFAULT 0;

      DECLARE cur CURSOR FOR
        SELECT z.id_zone,
               600 AS duration_sec,
               s.id_employee
        FROM plants.zones z
        LEFT JOIN plants.irrigation_schedule_settings s
          ON s.id_schedule = (
            SELECT s2.id_schedule
            FROM plants.irrigation_schedule_settings s2
            WHERE s2.id_zone = z.id_zone
            ORDER BY s2.id_schedule DESC
            LIMIT 1
          )
        WHERE z.id_technolog = 1
          AND COALESCE(s.is_enabled, 1) = 1;

      DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1;

      OPEN cur;
      read_loop: LOOP
        FETCH cur INTO v_zone, v_duration_sec, v_employee;
        IF done = 1 THEN
          LEAVE read_loop;
        END IF;

        CALL plants.start_irrigation_for_zone(v_zone, 'SCHEDULED', v_duration_sec, v_employee);
      END LOOP;
      CLOSE cur;
    END;
  END IF;
END$$
DELIMITER ;
