"""
Builds the interview setup workbook: the blank template the app offers for
download, and a realistic sample for testing the upload.

    python3 tools/setup-workbook/build.py

Writes:
    apps/web/public/templates/event-setup-template.xlsx   (served by the app)
    tools/setup-workbook/sample-event.xlsx                (10 days, 9 judges)
    apps/web/public/templates/candidates-template.xlsx    (served by the app)
    tools/setup-workbook/sample-candidates-batch{1,2}.xlsx

The sheet names, column headers and cell formats here are the contract with
the API's workbook reader (apps/api/src/setup-upload/workbook.ts). Change one,
change both.
"""
from datetime import date, time, timedelta
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
FIXED_SHEETS = {
    "Event": [
        ("Event name", True, 34, None),
        ("Location", False, 26, None),
        ("Timezone", False, 20, "Where the interviews happen, e.g. Asia/Singapore. Every time in this workbook is in this timezone. Default Asia/Singapore."),
        ("Minimum panel size", False, 12, "Fewest judges an interview needs. Slots with fewer available judges are left without a panel. Default 2."),
        ("Admin emails", False, 40, "Comma-separated. Each must already have a login (Users & roles); they become admins of this event."),
    ],
    "Day template": [
        ("Block", True, 10, "A name for the half-day block, e.g. AM or PM. The Availability sheet uses the same names."),
        ("Start time", True, 11, "24-hour HH:MM. Only on the first row of each block; the rest follow on one after another."),
        ("Item", True, 14, "Interview, Break or Calibration."),
        ("Duration (minutes)", True, 12, None),
    ],
    "Judges": [
        ("Name", True, 22, None),
        ("Email", True, 30, "Must be unique. The Availability sheet refers to judges by email."),
        ("Phone", False, 16, "With country code, e.g. +6591234567"),
        ("Organisation", False, 20, None),
        ("Designation", False, 22, None),
        ("Tier", False, 8, "Optional label: L1, L2, L3, L4, PS or V."),
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
    ("Interview setup workbook", "title"),
    ("Fill in the sheets and upload this file under Upload setup. The upload checks everything first and shows the schedule it will build. Nothing is saved until you confirm.", None),
    ("", None),
    ("How it works", "head"),
    ("Day template describes one day: each block (AM, PM) is a run of interviews, breaks and calibration with their lengths. Every judging day uses it.", None),
    ("Availability says which judges can sit which block on which date. The system builds every day's slots from the template and seats each judge in the interviews they are available for.", None),
    ("One panel interviews at a time. Interviews with fewer judges than the minimum panel size are left without a panel and shown greyed out.", None),
    ("Candidates are not in this workbook. Once the schedule exists, upload them in batches with the candidates file (Name, Date, Time), as they confirm.", None),
    ("", None),
    ("Availability format (the only accepted entries)", "head"),
    ("Yes = available for the whole block.", None),
    ("No, or blank = not available.", None),
    ("HH:MM-HH:MM in 24-hour time, e.g. 13:00-16:00 = available only within that window. The judge sits only the interviews that fit entirely inside it.", None),
    ("Anything else stops the upload and is listed with the judge and column so it can be corrected.", None),
    ("Column headers on the Availability sheet are the date and block: YYYY-MM-DD AM, YYYY-MM-DD PM. Add one column per date and block; dates with no judges simply stay empty.", None),
    ("", None),
    ("How to fill it in", "head"),
    ("Dark blue header = required column. Light blue header = optional. Hover a header for notes.", None),
    ("Yellow cells are examples. Overwrite or delete them before uploading.", None),
    ("Keep the sheet names and column headers as they are. Times are 24-hour HH:MM.", None),
    ("Criteria is optional. With no Criteria, the standard UOB rubric is used.", None),
]

TEMPLATE_DAY = (
    [("AM", time(9, 0), "Interview", 20)]
    + [("AM", None, "Interview", 20)] * 4
    + [("AM", None, "Break", 10)]
    + [("AM", None, "Interview", 20)] * 4
    + [("AM", None, "Calibration", 10)]
    + [("PM", time(14, 0), "Interview", 20)]
    + [("PM", None, "Interview", 20)] * 4
    + [("PM", None, "Break", 10)]
    + [("PM", None, "Interview", 20)] * 4
    + [("PM", None, "Calibration", 10)]
)


def style_header(ws, cols):
    for j, (header, required, width, note) in enumerate(cols, 1):
        c = ws.cell(1, j, header + (" *" if required else ""))
        c.font = Font(name=FONT, bold=True, color="FFFFFF")
        c.fill = REQUIRED if required else OPTIONAL
        c.alignment = Alignment(wrap_text=True, vertical="center")
        c.border = RULE
        ws.column_dimensions[c.column_letter].width = width
        if note:
            c.comment = Comment(note, "Template")
    ws.freeze_panes = "A2"
    ws.row_dimensions[1].height = 32


def write_rows(ws, rows, example):
    for r, values in enumerate(rows, 2):
        for j, v in enumerate(values, 1):
            c = ws.cell(r, j, v)
            c.font = Font(name=FONT)
            if example:
                c.fill = EXAMPLE
            if isinstance(v, time):
                c.number_format = "hh:mm"


def choices(ws, rng, options, strict=True):
    dv = DataValidation(type="list", formula1='"' + ",".join(options) + '"', allow_blank=True)
    if not strict:
        # A dropdown for the common answers that still accepts a typed time window.
        dv.showErrorMessage = False
    dv.add(rng)
    ws.add_data_validation(dv)


def build(data: dict, example: bool) -> Workbook:
    wb = Workbook()
    readme = wb.active
    readme.title = "Read me"
    for i, (line, kind) in enumerate(README, 1):
        c = readme.cell(i, 1, line)
        c.font = Font(name=FONT, bold=kind in ("title", "head"), size=14 if kind == "title" else 11)
        c.alignment = Alignment(wrap_text=True, vertical="top")
    readme.column_dimensions["A"].width = 120

    order = ["Event", "Day template", "Judges", "Availability", "Criteria"]
    for name in order:
        ws = wb.create_sheet(name)
        if name == "Availability":
            cols = [("Judge email", True, 30, "Exactly as on the Judges sheet.")]
            cols += [(h, False, 15, "Yes, No, or a window like 13:00-16:00") for h in data["availability_columns"]]
            style_header(ws, cols)
            # Date columns are part of the data, not fixed: style them like required headers.
            for j in range(2, len(cols) + 1):
                ws.cell(1, j).fill = REQUIRED
            write_rows(ws, data["availability"], example)
            last = ws.cell(1, len(cols)).column_letter
            choices(ws, f"B2:{last}500", ["Yes", "No"], strict=False)
            continue
        style_header(ws, FIXED_SHEETS[name])
        write_rows(ws, data.get(name, []), example)
        if name == "Day template":
            choices(ws, "C2:C200", ["Interview", "Break", "Calibration"])
        if name == "Judges":
            choices(ws, "F2:F500", ["L1", "L2", "L3", "L4", "PS", "V"])
        if name == "Criteria":
            choices(ws, "E2:E200", ["Y", "N"])
    return wb


def template_data() -> dict:
    cols = ["2026-10-19 AM", "2026-10-19 PM", "2026-10-20 AM", "2026-10-20 PM"]
    return {
        "Event": [("UOB Interviews October 2026", "UOB Plaza 1, Singapore", "Asia/Singapore", 2, "admin@example.com")],
        "Day template": TEMPLATE_DAY,
        "Judges": [
            ("Dean Tan", "dean@example.com", "+6591234567", "UOB", "Managing Director", "L2"),
            ("Lawrance Lim", "lawrance@example.com", "+6598765432", "UOB", "Executive Director", "L3"),
            ("Choon Hin Ong", "choonhin@example.com", "+6590001111", "UOB", "Director", "L3"),
        ],
        "availability_columns": cols,
        "availability": [
            ("dean@example.com", "Yes", "Yes", "No", "No"),
            ("lawrance@example.com", "Yes", "13:00-16:00", "No", "Yes"),
            ("choonhin@example.com", "Yes", "Yes", "Yes", "Yes"),
        ],
    }


def sample_data() -> dict:
    """Ten weekdays from 19 Oct 2026, nine judges, gaps, and partial windows."""
    judges = [
        ("Jack", "jack@example.com"), ("Eric", "eric@example.com"), ("Lay Wah", "laywah@example.com"),
        ("Yung Chee", "yungchee@example.com"), ("Lawrance", "lawrance@example.com"),
        ("Choon Hin", "choonhin@example.com"), ("Hendra", "hendra@example.com"),
        ("Wei Wei", "weiwei@example.com"), ("Dean", "dean@example.com"),
    ]
    days, d = [], date(2026, 10, 19)
    while len(days) < 10:
        if d.weekday() < 5:
            days.append(d)
        d += timedelta(days=1)
    cols = [f"{day.isoformat()} {b}" for day in days for b in ("AM", "PM")]

    # Who sits when: a few judges per day, a blank day (day 4), and partial windows.
    plan = {
        0: {"jack": "Yes", "hendra": "Yes", "weiwei": "Yes"},
        1: {"jack": "Yes", "dean": "Yes", "lawrance": "13:00-16:00"},
        2: {"eric": "Yes", "laywah": "Yes", "yungchee": "Yes"},
        3: {"eric": "Yes", "laywah": "Yes", "choonhin": "14:00-15:00"},
        4: {"dean": "Yes", "lawrance": "Yes", "choonhin": "Yes"},
        5: {"dean": "Yes", "lawrance": "Yes", "choonhin": "Yes"},
        8: {"jack": "Yes", "eric": "Yes"},
        9: {"jack": "Yes", "eric": "Yes", "hendra": "13:00-16:00"},
        12: {"yungchee": "Yes", "weiwei": "Yes", "laywah": "Yes"},
        13: {"yungchee": "Yes", "weiwei": "Yes", "laywah": "Yes"},
        16: {"dean": "Yes", "jack": "Yes", "choonhin": "Yes"},
        17: {"dean": "Yes", "jack": "Yes"},
        18: {"hendra": "Yes", "weiwei": "Yes", "eric": "Yes"},
        19: {"hendra": "Yes", "weiwei": "09:00-10:00", "eric": "Yes"},
    }
    availability = []
    for name, email in judges:
        key = email.split("@")[0]
        availability.append((email, *[plan.get(i, {}).get(key, "No") for i in range(len(cols))]))

    return {
        "Event": [("Sample Interview Fortnight", "UOB Plaza 1", "Asia/Singapore", 2, "")],
        "Day template": TEMPLATE_DAY,
        "Judges": [(n, e, f"+659000{i:04d}", "UOB", "Panel member", "L3") for i, (n, e) in enumerate(judges, 1)],
        "availability_columns": cols,
        "availability": availability,
    }


CANDIDATE_COLS = [
    ("Name", True, 30, "The candidate's name. Must be unique in the event; uploading the same name again moves that candidate."),
    ("Date", True, 13, "YYYY-MM-DD, the day of the interview."),
    ("Time", True, 10, "24-hour HH:MM: the start time of an interview slot on the schedule, e.g. 09:20."),
]

CANDIDATE_README = [
    ("Candidates file", "title"),
    ("Upload this under Upload candidates once the schedule exists. Upload as often as you like: each file adds the candidates in it, and moves any already placed whose slot changed. Candidates not in the file are left where they are.", None),
    ("", None),
    ("Name, Date and Time are all required. Time is the start of an interview slot exactly as it appears on the schedule.", None),
    ("A row is refused if the slot doesn't exist, has no panel, already has another candidate, or if the candidate's interview has already started.", None),
]


def build_candidates(rows, example: bool) -> Workbook:
    wb = Workbook()
    readme = wb.active
    readme.title = "Read me"
    for i, (line, kind) in enumerate(CANDIDATE_README, 1):
        c = readme.cell(i, 1, line)
        c.font = Font(name=FONT, bold=kind == "title", size=14 if kind == "title" else 11)
        c.alignment = Alignment(wrap_text=True, vertical="top")
    readme.column_dimensions["A"].width = 110
    ws = wb.create_sheet("Candidates")
    style_header(ws, CANDIDATE_COLS)
    write_rows(ws, rows, example)
    for r in range(2, len(rows) + 2):
        ws.cell(r, 2).number_format = "yyyy-mm-dd"
    return wb


def sample_batches():
    """Two batches for the sample event: the first fortnight's early confirmations, then more plus one move."""
    am = [time(9, 0), time(9, 20), time(9, 40), time(10, 0), time(10, 20), time(10, 50), time(11, 10), time(11, 30), time(11, 50)]
    first = [(f"Candidate {i + 1:03d}", date(2026, 10, 19), am[i]) for i in range(9)]
    second = [(f"Candidate {i + 10:03d}", date(2026, 10, 21), am[i]) for i in range(6)]
    second.append(("Candidate 001", date(2026, 10, 21), am[6]))  # moved from 19 Oct 09:00
    return first, second


if __name__ == "__main__":
    out = ROOT / "apps/web/public/templates/event-setup-template.xlsx"
    out.parent.mkdir(parents=True, exist_ok=True)
    build(template_data(), example=True).save(out)
    print("wrote", out.relative_to(ROOT))
    sample = ROOT / "tools/setup-workbook/sample-event.xlsx"
    build(sample_data(), example=False).save(sample)
    print("wrote", sample.relative_to(ROOT))
    ctemplate = ROOT / "apps/web/public/templates/candidates-template.xlsx"
    build_candidates([("Candidate One", date(2026, 10, 19), time(9, 0)), ("Candidate Two", date(2026, 10, 19), time(9, 20))], example=True).save(ctemplate)
    print("wrote", ctemplate.relative_to(ROOT))
    first, second = sample_batches()
    for n, rows in ((1, first), (2, second)):
        out = ROOT / f"tools/setup-workbook/sample-candidates-batch{n}.xlsx"
        build_candidates(rows, example=False).save(out)
        print("wrote", out.relative_to(ROOT))
