"""
python scrum.py add [id] "name"
eg python scrum.py add 5.1 "CutShape"
python scrum.py list
"""

import os
import re
import argparse

# Configuration
BOARD_DIR = "scrum"
os.makedirs(BOARD_DIR, exist_ok=True)
COLUMNS = {
    "Backlog": os.path.join(BOARD_DIR, "product_backlog.md"),
    "Sprint": os.path.join(BOARD_DIR, "sprint.md"),
    "Completed": os.path.join(BOARD_DIR, "completed.md")
}

def load_tasks():
    """Parses files by looking for the explicit 'ID : [text]' line."""
    tasks = {}
    # Matches 'ID : ' followed by any non-whitespace characters
    id_pattern = re.compile(r"ID\s+:\s+(\S+)")
    
    for status, filepath in COLUMNS.items():
        if not os.path.exists(filepath): continue
        with open(filepath, "r", encoding="utf-8") as f:
            blocks = f.read().split('--------------------------------------------------------------------------------')
            for block in blocks:
                block = block.strip()
                if not block: continue
                match = id_pattern.search(block)
                if match:
                    tid = match.group(1) # ID is now a string
                    full_block = f"--------------------------------------------------------------------------------\n{block}\n--------------------------------------------------------------------------------"
                    tasks[tid] = {"status": status, "content": full_block}
    return tasks

def save_tasks(tasks):
    """Writes all tasks back to files."""
    for path in COLUMNS.values():
        with open(path, "w", encoding="utf-8") as f:
            f.write("")
            
    for tid, data in tasks.items():
        path = COLUMNS.get(data["status"])
        if path:
            with open(path, "a", encoding="utf-8") as f:
                f.write(data["content"] + "\n\n")

def list_board():
    tasks = load_tasks()
    save_tasks(tasks)
    print("\n" + "="*30 + "\n SQUAT FORM CHECKER BOARD\n" + "="*30)
    for status in COLUMNS:
        print(f"\n📌 {status.upper()}")
        found = [tid for tid, data in tasks.items() if data["status"] == status]
        if not found: print("   (Empty)")
        for tid in found:
            print(f"   #{tid}")

def add_task(tid, title):
    tasks = load_tasks()
    if tid in tasks:
        print(f"❌ ID #{tid} already exists!")
        return
        
    content = (
        f"--------------------------------------------------------------------------------\n"
        f"ID       : {tid}\n"
        f"TYPE     : USER STORY : [ASSIGNED] : [STATUS]\n"
        f"Name     : {title}\n"
        f"PRIORITY : 1\n"
        f"ESTIMATE : (1 hour, 2 hours, 4 hours, 1 day, 2 days, 4 days)   ACTUAL :\n"
        f"AS A     : USER\n"
        f"I WANT   : \n"
        f"SO THAT  : \n"
        f"--------------------------------------------------------------------------------"
    )
    tasks[tid] = {"status": "Backlog", "content": content}
    save_tasks(tasks)
    print(f"✅ Added #{tid}: {title}")

def main():
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command")
    
    add = subparsers.add_parser("add")
    add.add_argument("id")
    add.add_argument("title")
    
    subparsers.add_parser("list")
    
    args = parser.parse_args()
    if args.command == "add": add_task(args.id, args.title)
    elif args.command == "list": list_board()

if __name__ == "__main__":
    main()