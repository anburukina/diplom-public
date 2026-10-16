import mysql.connector, sys, traceback
cfg = dict(host='127.0.0.1', port=3306, user='root', password='************', database='plants', connection_timeout=5)
print('starting')
try:
    conn = mysql.connector.connect(**cfg)
    print('connected')
    cur = conn.cursor()
    cur.execute('SELECT id_parameter, name_parameter, id_units FROM parameters')
    rows = cur.fetchall()
    print('rows', len(rows))
    for r in rows:
        print(r)
except Exception:
    traceback.print_exc()
    sys.exit(1)
finally:
    try:
        cur.close(); conn.close()
    except Exception:
        pass
