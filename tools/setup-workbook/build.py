"""
Builds the event setup workbook: the blank template the app offers for
download, and a realistic sample event for testing the upload.

    python3 tools/setup-workbook/build.py

Writes:
    apps/web/public/templates/event-setup-template.xlsx   (served by the app)
    tools/setup-workbook/sample-event.xlsx                (12 teams, 2 days)

The column headers here are the contract with the API's workbook reader
(apps/api/src/setup-upload/workbook.ts). Change one, change both.
"""
from datetime import date, time, timedelta, datetime
from pathlib import Path

from openpyxl import Workbook
from openpyxl.comments import Comment
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.worksheet.datavalidation import DataValidation

ROOT = Path(__file__).resolve().parents[2]
FONT = "Arial"
REQUIRED = PatternFill("solid", fgColor="1F3864")
OPTIONAL = PatternFill("solid", fgColor="8EA9DB")
EXAMPLE = PatternFill("solid", fgColor="FFF2CC")
RULE = Border(bottom=Side(style="thin", color="BFBFBF"))

# (header, required, width, note)
SHEETS = {
    "Event": [
        ("Event name", True, 34, None),
        ("Location", False, 26, None),
        ("Timezone", False, 20, "Where the event happens, e.g. Asia/Singapore. All times on the Schedule are in this timezone. Default Asia/Singapore."),
        ("Session length (minutes)", True, 16, "The usual length of a judging session. Each Schedule row still has its own start and end."),
        ("Admin emails", False, 40, "Comma-separated. Each must already have a login (Users & roles); they become admins of this event."),
    ],
    "Rooms": [
        ("Room name", True, 22, "Must be unique. The Schedule refers to rooms by this name."),
        ("Location", False, 26, None),
        ("Video conferencing", False, 16, "Y if a team can present by video in this room."),
    ],
    "Teams": [
        ("Team name", True, 24, "Must be unique. The Schedule refers to teams by this name."),
        ("Project name", True, 28, None),
        ("Track", False, 22, "Tracks are created from this column."),
        ("Country", False, 10, "2-letter code, e.g. SG"),
        ("Organisation", False, 20, None),
        ("Team lead name", True, 20, None),
        ("Team lead email", True, 28, None),
        ("Presentation mode", False, 16, "In person or Video. Default In person."),
        ("Problem statement", False, 40, None),
        ("Solution summary", False, 40, None),
    ],
    "Judges": [
        ("Name", True, 22, None),
        ("Email", True, 30, "Must be unique. The Schedule refers to judges by email."),
        ("Phone", False, 16, "With country code, e.g. +6591234567"),
        ("Organisation", False, 20, None),
        ("Designation", False, 22, None),
        ("Tier", False, 8, "Optional label: L1, L2, L3, L4, PS or V."),
    ],
    "Schedule": [
        ("Date", True, 13, "YYYY-MM-DD, or an Excel date. 12/10/2026 style dates are refused: they read differently in different countries."),
        ("Start time", True, 11, "24-hour HH:MM, in the event's timezone."),
        ("End time", True, 11, "24-hour HH:MM."),
        ("Room", True, 14, "Exactly as on the Rooms sheet."),
        ("Team name", True, 22, "Exactly as on the Teams sheet. Each team appears once."),
        ("Judge 1 email", True, 28, "Exactly as on the Judges sheet."),
        ("Judge 2 email", False, 28, None),
        ("Judge 3 email", False, 28, None),
        ("Judge 4 email", False, 28, None),
        ("Judge 5 email", False, 28, None),
    ],
    "Criteria": [
        ("Criterion", True, 44, "A category (leave Parent blank) or a row inside one."),
        ("Parent criterion", False, 34, "For a row: the exact name of its category. Blank for a category."),
        ("Max score", True, 10, "Categories must add up to 100. Each category's rows must add up to the category's max."),
        ("Guidance", False, 50, "Shown to judges under the row."),
        ("Comment required", False, 12, "Y if the judge must comment on this row."),
    ],
}

README = [
    ("Event setup workbook", "title"),
    ("Fill in every sheet and upload this file under Upload setup. The upload checks everything first, shows you what it will create, and only builds the event when you confirm. It then opens the Command Centre.", None),
    ("", None),
    ("How to fill it in", "head"),
    ("Dark blue header = required column. Light blue header = optional. Hover a header for notes.", None),
    ("Yellow rows are examples. Overwrite or delete them before uploading.", None),
    ("Keep the sheet names and column headers as they are.", None),
    ("Dates as YYYY-MM-DD (2026-10-12). Times as 24-hour HH:MM (09:30), in the event's timezone.", None),
    ("The Schedule refers to rooms, teams and judges by name / email exactly as written on their own sheets.", None),
    ("", None),
    ("Sheets", "head"),
    ("Event: one row describing the event.", None),
    ("Rooms: one row per judging room.", None),
    ("Teams: one row per team. Tracks are created from the Track column.", None),
    ("Judges: one row per judge. Email identifies the judge and must be unique.", None),
    ("Schedule: one row per judging session. Each team appears once. The judging days are the dates used here.", None),
    ("Criteria (optional): the scoring rubric. Leave it empty to use the standard UOB rubric.", None),
    ("", None),
    ("What blocks an upload", "head"),
    ("An empty required cell; a room, team or judge on the Schedule that isn't on its own sheet; a team scheduled twice; a judge or room booked twice at overlapping times; an end time not after the start; duplicate team names or judge emails; a rubric that doesn't add up.", None),
    ("", None),
    ("What only warns", "head"),
    ("A session with one judge; a video team in a room without video conferencing; a judge with more than 8 sessions in a day; teams, judges or rooms that aren't used; admin emails without a login.", None),
    ("", None),
    ("Uploading again", "head"),
    ("You can upload a corrected file for the same event until the first score is entered. It replaces the whole setup.", None),
]


def build(rows_by_sheet: dict, example: bool) -> Workbook:
    wb = Workbook()
    readme = wb.active
    readme.title = "Read me"
    for i, (line, kind) in enumerate(README, 1):
        c = readme.cell(i, 1, line)
        c.font = Font(name=FONT, bold=kind in ("title", "head"), size=14 if kind == "title" else 11)
        c.alignment = Alignment(wrap_text=True, vertical="top")
    readme.column_dimensions["A"].width = 120

    for name, cols in SHEETS.items():
        ws = wb.create_sheet(name)
        for j, (header, required, width, note) in enumerate(cols, 1):
            c = ws.cell(1, j, header + (" *" if required else ""))
            c.font = Font(name=FONT, bold=True, color="FFFFFF")
            c.fill = REQUIRED if required else OPTIONAL
            c.alignment = Alignment(wrap_text=True, vertical="center")
            c.border = RULE
            ws.column_dimensions[c.column_letter].width = width
            if note:
                c.comment = Comment(note, "Template")
        for r, values in enumerate(rows_by_sheet.get(name, []), 2):
            for j, v in enumerate(values, 1):
                c = ws.cell(r, j, v)
                c.font = Font(name=FONT)
                if example:
                    c.fill = EXAMPLE
                if isinstance(v, date):
                    c.number_format = "yyyy-mm-dd"
                elif isinstance(v, time):
                    c.number_format = "hh:mm"
        ws.freeze_panes = "A2"
        ws.row_dimensions[1].height = 32

        def choices(col: str, options: list[str]):
            dv = DataValidation(type="list", formula1='"' + ",".join(options) + '"', allow_blank=True)
            dv.add(f"{col}2:{col}2000")
            ws.add_data_validation(dv)

        if name == "Rooms":
            choices("C", ["Y", "N"])
        if name == "Teams":
            choices("H", ["In person", "Video"])
        if name == "Judges":
            choices("F", ["L1", "L2", "L3", "L4", "PS", "V"])
        if name == "Criteria":
            choices("E", ["Y", "N"])
    return wb


TEMPLATE_ROWS = {
    "Event": [("UOB Innovation Challenge 2026", "UOB Plaza 1, Singapore", "Asia/Singapore", 25, "admin@example.com")],
    "Rooms": [("Room A", "Level 12", "Y"), ("Room B", "Level 12", "N")],
    "Teams": [
        ("Team Alpha", "Smart Onboarding", "Customer Experience", "SG", "UOB Singapore", "Tan Wei Ling", "weiling@example.com", "In person",
         "Account opening takes 3 days.", "Guided digital onboarding with document OCR."),
        ("Team Beta", "Fraud Radar", "Risk", "MY", "UOB Malaysia", "Ahmad Faiz", "faiz@example.com", "Video",
         "Card fraud is detected too late.", "Real-time anomaly scoring on transactions."),
    ],
    "Judges": [
        ("Lim Chee Keong", "cheekeong@example.com", "+6591234567", "UOB", "Managing Director", "L2"),
        ("Priya Nair", "priya@example.com", "+6598765432", "UOB", "Executive Director", "L3"),
        ("Daniel Wong", "daniel@example.com", "+6590001111", "UOB", "Senior Engineer", "PS"),
    ],
    "Schedule": [
        (date(2026, 10, 12), time(9, 30), time(9, 55), "Room A", "Team Alpha", "cheekeong@example.com", "priya@example.com", "daniel@example.com"),
        (date(2026, 10, 13), time(9, 30), time(9, 55), "Room B", "Team Beta", "cheekeong@example.com", "priya@example.com", "daniel@example.com"),
    ],
}


def sample_rows() -> dict:
    """12 teams over 2 days, 2 rooms, 6 judges, panels of 3, 25-minute sessions."""
    tracks = ["Customer Experience", "Risk", "Operations"]
    countries = ["SG", "MY", "TH", "ID", "VN", "CN"]
    teams = []
    for i in range(12):
        n = i + 1
        teams.append((
            f"Team {n:02d}", f"Project {n:02d}", tracks[i % 3], countries[i % 6], "UOB",
            f"Lead {n:02d}", f"lead{n:02d}@example.com", "Video" if n in (4, 9) else "In person",
            f"Problem statement for team {n:02d}.", f"Solution summary for team {n:02d}.",
        ))
    judges = [
        ("Judge Ang", "ang@example.com", "+6590000001", "UOB", "Managing Director", "L2"),
        ("Judge Bala", "bala@example.com", "+6590000002", "UOB", "Executive Director", "L3"),
        ("Judge Chen", "chen@example.com", "+6590000003", "UOB", "Senior Engineer", "PS"),
        ("Judge Devi", "devi@example.com", "+6590000004", "UOB", "Managing Director", "L2"),
        ("Judge Eng", "eng@example.com", "+6590000005", "UOB", "Executive Director", "L3"),
        ("Judge Farah", "farah@example.com", "+6590000006", "UOB", "Senior Engineer", "PS"),
    ]
    panels = {"Room A": ["ang@example.com", "bala@example.com", "chen@example.com"],
              "Room B": ["devi@example.com", "eng@example.com", "farah@example.com"]}
    schedule = []
    days = [date(2026, 10, 12), date(2026, 10, 13)]
    t = 0
    for day in days:
        for slot in range(3):
            start = datetime.combine(day, time(9, 30)) + timedelta(minutes=30 * slot)
            end = start + timedelta(minutes=25)
            for room in ("Room A", "Room B"):
                team = teams[t][0]
                t += 1
                schedule.append((day, start.time(), end.time(), room, team, *panels[room]))
    return {
        "Event": [("Sample Day-Based Event", "UOB Plaza 1", "Asia/Singapore", 25, "")],
        "Rooms": [("Room A", "Level 12", "Y"), ("Room B", "Level 12", "Y")],
        "Teams": teams,
        "Judges": judges,
        "Schedule": schedule,
    }


if __name__ == "__main__":
    out = ROOT / "apps/web/public/templates/event-setup-template.xlsx"
    out.parent.mkdir(parents=True, exist_ok=True)
    build(TEMPLATE_ROWS, example=True).save(out)
    print("wrote", out.relative_to(ROOT))
    sample = ROOT / "tools/setup-workbook/sample-event.xlsx"
    build(sample_rows(), example=False).save(sample)
    print("wrote", sample.relative_to(ROOT))
