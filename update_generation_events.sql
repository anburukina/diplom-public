DROP EVENT IF EXISTS insert_fake_measurements;
DROP EVENT IF EXISTS insert_fake_measurements;
DROP EVENT IF EXISTS generate_solution_aero;
DROP EVENT IF EXISTS generate_solution_hydro_06;
DROP EVENT IF EXISTS generate_solution_hydro_10;
DROP EVENT IF EXISTS generate_solution_hydro_14;
DROP EVENT IF EXISTS generate_solution_hydro_18;
DROP EVENT IF EXISTS generate_solution_hydro_22;

DELIMITER $$

CREATE DEFINER=`root`@`localhost` EVENT `insert_fake_measurements`
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
  SET v_humidity = LEAST(
    80,
    GREATEST(
      70,
      IFNULL(v_humidity, 75)
        + (75 - IFNULL(v_humidity, 75)) * 0.04
        + (RAND() - 0.5) * 0.9
    )
  );
  SET v_co2 = LEAST(1500, GREATEST(1000, IFNULL(v_co2, 1250) + (1250 - IFNULL(v_co2, 1250)) * 0.03 + (RAND() - 0.5) * 24));

  INSERT INTO plants.sensors_measurements (id_sensors, id_parameter, value, id_zone)
  VALUES
    ((SELECT id_sensor FROM plants.sensors WHERE id_parameterss = 1 ORDER BY id_sensor LIMIT 1), 1, ROUND(v_temp, 1), NULL),
    ((SELECT id_sensor FROM plants.sensors WHERE id_parameterss = 2 ORDER BY id_sensor LIMIT 1), 2, ROUND(v_humidity, 1), NULL),
    ((SELECT id_sensor FROM plants.sensors WHERE id_parameterss = 3 ORDER BY id_sensor LIMIT 1), 3, ROUND(v_co2, 0), NULL);

  BEGIN
    DECLARE done INT DEFAULT 0;
    DECLARE v_zone INT;
    DECLARE v_tech INT;

    DECLARE cur CURSOR FOR
      SELECT id_zone, id_technolog
      FROM plants.zones;

    DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1;

    OPEN cur;

    zone_loop: LOOP
      FETCH cur INTO v_zone, v_tech;
      IF done = 1 THEN
        LEAVE zone_loop;
      END IF;

      IF v_tech = 1 THEN
        INSERT INTO plants.sensors_measurements (id_sensors, id_parameter, value, id_zone)
        VALUES ((SELECT id_sensor FROM plants.sensors WHERE id_parameterss = 4 ORDER BY id_sensor LIMIT 1), 4, ROUND(5.9 + RAND() * 0.2, 2), v_zone);
      ELSEIF v_tech = 2 THEN
        INSERT INTO plants.sensors_measurements (id_sensors, id_parameter, value, id_zone)
        VALUES ((SELECT id_sensor FROM plants.sensors WHERE id_parameterss = 7 ORDER BY id_sensor LIMIT 1), 7, ROUND(95 + RAND() * 5, 1), v_zone);
      END IF;
    END LOOP;

    CLOSE cur;
  END;
END$$

CREATE DEFINER=`root`@`localhost` EVENT `generate_solution_aero`
ON SCHEDULE EVERY 15 MINUTE
STARTS '2026-02-13 00:00:00'
ON COMPLETION NOT PRESERVE
ENABLE
DO
BEGIN
  IF MINUTE(NOW()) IN (0, 15, 30, 45) AND SECOND(NOW()) < 2 THEN
    BEGIN
      DECLARE v_zone INT;
      DECLARE done INT DEFAULT 0;

      DECLARE cur CURSOR FOR
        SELECT z.id_zone
        FROM plants.zones z
        WHERE z.id_technolog = 2;

      DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1;

      OPEN cur;

      read_loop: LOOP
        FETCH cur INTO v_zone;
        IF done = 1 THEN
          LEAVE read_loop;
        END IF;

        CALL plants.start_irrigation_for_zone(v_zone, 'SCHEDULED', 10, NULL);
      END LOOP;

      CLOSE cur;
    END;
  END IF;
END$$

CREATE DEFINER=`root`@`localhost` EVENT `generate_solution_hydro_06`
ON SCHEDULE EVERY 1 DAY
STARTS '2026-02-13 06:00:00'
ON COMPLETION NOT PRESERVE
ENABLE
DO
BEGIN
  IF TIME(NOW()) BETWEEN '06:00:00' AND '06:00:02' THEN
    BEGIN
      DECLARE v_zone INT;
      DECLARE done INT DEFAULT 0;

      DECLARE cur CURSOR FOR
        SELECT z.id_zone
        FROM plants.zones z
        WHERE z.id_technolog = 1;

      DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1;

      OPEN cur;

      read_loop: LOOP
        FETCH cur INTO v_zone;
        IF done = 1 THEN
          LEAVE read_loop;
        END IF;

        CALL plants.start_irrigation_for_zone(v_zone, 'SCHEDULED', 600, NULL);
      END LOOP;

      CLOSE cur;
    END;
  END IF;
END$$

CREATE DEFINER=`root`@`localhost` EVENT `generate_solution_hydro_10`
ON SCHEDULE EVERY 1 DAY
STARTS '2026-02-13 10:00:00'
ON COMPLETION NOT PRESERVE
ENABLE
DO
BEGIN
  IF TIME(NOW()) BETWEEN '10:00:00' AND '10:00:02' THEN
    BEGIN
      DECLARE v_zone INT;
      DECLARE done INT DEFAULT 0;

      DECLARE cur CURSOR FOR
        SELECT z.id_zone
        FROM plants.zones z
        WHERE z.id_technolog = 1;

      DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1;

      OPEN cur;

      read_loop: LOOP
        FETCH cur INTO v_zone;
        IF done = 1 THEN
          LEAVE read_loop;
        END IF;

        CALL plants.start_irrigation_for_zone(v_zone, 'SCHEDULED', 600, NULL);
      END LOOP;

      CLOSE cur;
    END;
  END IF;
END$$

CREATE DEFINER=`root`@`localhost` EVENT `generate_solution_hydro_14`
ON SCHEDULE EVERY 1 DAY
STARTS '2026-02-13 14:00:00'
ON COMPLETION NOT PRESERVE
ENABLE
DO
BEGIN
  IF TIME(NOW()) BETWEEN '14:00:00' AND '14:00:02' THEN
    BEGIN
      DECLARE v_zone INT;
      DECLARE done INT DEFAULT 0;

      DECLARE cur CURSOR FOR
        SELECT z.id_zone
        FROM plants.zones z
        WHERE z.id_technolog = 1;

      DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1;

      OPEN cur;

      read_loop: LOOP
        FETCH cur INTO v_zone;
        IF done = 1 THEN
          LEAVE read_loop;
        END IF;

        CALL plants.start_irrigation_for_zone(v_zone, 'SCHEDULED', 600, NULL);
      END LOOP;

      CLOSE cur;
    END;
  END IF;
END$$

CREATE DEFINER=`root`@`localhost` EVENT `generate_solution_hydro_18`
ON SCHEDULE EVERY 1 DAY
STARTS '2026-02-13 18:00:00'
ON COMPLETION NOT PRESERVE
ENABLE
DO
BEGIN
  IF TIME(NOW()) BETWEEN '18:00:00' AND '18:00:02' THEN
    BEGIN
      DECLARE v_zone INT;
      DECLARE done INT DEFAULT 0;

      DECLARE cur CURSOR FOR
        SELECT z.id_zone
        FROM plants.zones z
        WHERE z.id_technolog = 1;

      DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1;

      OPEN cur;

      read_loop: LOOP
        FETCH cur INTO v_zone;
        IF done = 1 THEN
          LEAVE read_loop;
        END IF;

        CALL plants.start_irrigation_for_zone(v_zone, 'SCHEDULED', 600, NULL);
      END LOOP;

      CLOSE cur;
    END;
  END IF;
END$$

CREATE DEFINER=`root`@`localhost` EVENT `generate_solution_hydro_22`
ON SCHEDULE EVERY 1 DAY
STARTS '2026-02-13 22:00:00'
ON COMPLETION NOT PRESERVE
ENABLE
DO
BEGIN
  IF TIME(NOW()) BETWEEN '22:00:00' AND '22:00:02' THEN
    BEGIN
      DECLARE v_zone INT;
      DECLARE done INT DEFAULT 0;

      DECLARE cur CURSOR FOR
        SELECT z.id_zone
        FROM plants.zones z
        WHERE z.id_technolog = 1;

      DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1;

      OPEN cur;

      read_loop: LOOP
        FETCH cur INTO v_zone;
        IF done = 1 THEN
          LEAVE read_loop;
        END IF;

        CALL plants.start_irrigation_for_zone(v_zone, 'SCHEDULED', 600, NULL);
      END LOOP;

      CLOSE cur;
    END;
  END IF;
END$$

DELIMITER ;

DROP EVENT IF EXISTS generate_ph_ec_aero;
DROP EVENT IF EXISTS generate_ph_ec_hydro_06;
DROP EVENT IF EXISTS generate_ph_ec_hydro_10;
DROP EVENT IF EXISTS generate_ph_ec_hydro_14;
DROP EVENT IF EXISTS generate_ph_ec_hydro_18;
DROP EVENT IF EXISTS generate_ph_ec_hydro_22;
