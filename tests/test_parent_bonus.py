from pathlib import Path
import copy
import json
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sync"))
import family

class ParentBonusTest(unittest.TestCase):
    def test_both_parents_retries_undo_and_remarks_recalculate_one_journal(self):
        day = family.PARENT_REWARD_SINCE
        now = day * family.DAY - family.OFFSET + 12 * 3600000
        with tempfile.TemporaryDirectory() as directory, patch.object(family, "now_ms", return_value=now):
            database = Path(directory) / "journal.sqlite3"
            family.initialize(database)
            with family.transaction(database, write=True) as db:
                menu = {"morning": [[key,key] for key in ["bed","teeth","dress","breakfast","car"]],
                        "afternoon": [["wash","Wash"],["toys","Toys"]], "afternoonMinutes": 5,
                        "rewards": [["fill","Fill",30]], "video": {"title":"Video","minutes":15,"bats":0}}
                db.execute("INSERT OR REPLACE INTO family_catalog VALUES(?,?)", (day,json.dumps([menu]*family.CHILD_COUNT)))
                tasks = [key for key,_ in menu["morning"]+menu["afternoon"]]+["bonus:fill"]
                for index, task in enumerate(tasks):
                    db.execute("INSERT INTO family_cells(day,child,task,at,checked,locked,version,guard) VALUES(?,?,?,?,1,0,?,?)",
                               (day,0,task,now-10000+index,f"{index+1:032x}",""))
            def act(number,actor,action,**fields):
                body={"id":f"{number:032x}","day":day,"child":0,"action":action,"note":"test",**fields}
                return family.parent_action(database,actor,body)
            one=act(100,"Parent A","point")
            self.assertEqual(one["wallets"][0],5)
            repeat=act(100,"Parent A","point")
            self.assertEqual(repeat["wallets"][0],5)
            two=act(101,"Parent B","point")
            self.assertEqual(two["wallets"][0],10)
            penalty=act(102,"Parent A","remark")
            self.assertEqual(penalty["wallets"][0],5)
            self.assertEqual(act(103,"Parent B","undo",target=f"{101:032x}")["wallets"][0],0)
            self.assertEqual(act(104,"Parent A","undo",target=f"{102:032x}")["wallets"][0],5)
            with family.transaction(database) as db:
                self.assertEqual(db.execute("SELECT COUNT(*) FROM family_adjustments").fetchone()[0],3)
                self.assertEqual(db.execute("SELECT COUNT(*) FROM family_audit WHERE action='point'").fetchone()[0],2)
