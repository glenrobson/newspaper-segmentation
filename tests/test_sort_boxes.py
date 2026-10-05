import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'app'))

from main import _sort_boxes_reading_order


def box(x, y, w, h):
    return {'x': x, 'y': y, 'w': w, 'h': h}


def test_left_column_before_right_column_no_vertical_overlap():
    """Left-column box should come first even when a right-column box sits
    much higher on the page (Tagesneuigkeiten case: x=553,y=1157 vs x=1018,y=95)."""
    left  = box(553, 1157, 470, 1103)
    right = box(1018,  95, 461,  245)
    result = _sort_boxes_reading_order([left, right])
    assert result == [left, right], (
        "Left column (x=553) should precede top-right column (x=1018) "
        "even though top-right has smaller y"
    )


def test_two_columns_same_y():
    """Standard two-column layout: left column before right, both starting at same Y."""
    left  = box(100, 200, 300, 500)
    right = box(450, 200, 300, 500)
    result = _sort_boxes_reading_order([left, right])
    assert result == [left, right]


def test_single_column_top_to_bottom():
    """Single column with multiple stacked regions: ordered top-to-bottom."""
    top    = box(100, 100, 300, 200)
    middle = box(100, 320, 300, 200)
    bottom = box(100, 540, 300, 200)
    result = _sort_boxes_reading_order([bottom, top, middle])
    assert result == [top, middle, bottom]


def test_same_column_horizontal_overlap():
    """Boxes that overlap significantly in X are treated as the same column
    and ordered top-to-bottom regardless of horizontal position."""
    top_wide   = box(100, 100, 600, 100)  # headline spanning full width
    left_body  = box(100, 250, 280, 400)
    right_body = box(420, 250, 280, 400)
    # Headline overlaps both body columns → all in one group → Y order
    result = _sort_boxes_reading_order([left_body, right_body, top_wide])
    assert result[0] == top_wide, "Headline (topmost Y) should be first"


def test_empty():
    assert _sort_boxes_reading_order([]) == []


def test_single_box():
    b = box(10, 20, 100, 200)
    assert _sort_boxes_reading_order([b]) == [b]
