//! The drawing surface: a grid of cells, each empty, a road or a house.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Cell {
    Empty,
    Road,
    House,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Grid {
    pub cols: usize,
    pub rows: usize,
    pub cells: Vec<Cell>,
}

/// Neighbour offsets as (column, row): north, east, south, west.
pub const DIRS: [(i32, i32); 4] = [(0, -1), (1, 0), (0, 1), (-1, 0)];

impl Grid {
    pub fn new(cols: usize, rows: usize) -> Self {
        Self {
            cols,
            rows,
            cells: vec![Cell::Empty; cols * rows],
        }
    }

    pub fn index(&self, col: usize, row: usize) -> usize {
        row * self.cols + col
    }

    pub fn col_row(&self, index: usize) -> (usize, usize) {
        (index % self.cols, index / self.cols)
    }

    /// The cell next to `index` in direction `dir` (0 north, 1 east, 2 south, 3 west).
    pub fn neighbour(&self, index: usize, dir: usize) -> Option<usize> {
        let (c, r) = self.col_row(index);
        let c = c as i32 + DIRS[dir].0;
        let r = r as i32 + DIRS[dir].1;
        if c < 0 || r < 0 || c >= self.cols as i32 || r >= self.rows as i32 {
            return None;
        }
        Some(self.index(c as usize, r as usize))
    }

    pub fn is_road(&self, index: usize) -> bool {
        self.cells[index] == Cell::Road
    }

    /// The neighbouring road cell in direction `dir`, if there is one.
    pub fn road_neighbour(&self, index: usize, dir: usize) -> Option<usize> {
        self.neighbour(index, dir).filter(|&n| self.is_road(n))
    }

    pub fn road_degree(&self, index: usize) -> usize {
        (0..4)
            .filter(|&d| self.road_neighbour(index, d).is_some())
            .count()
    }

    /// Read a map drawn with `#` for road, `H` for house and `.` for empty.
    pub fn parse(lines: &[&str]) -> Result<Self, String> {
        let rows: Vec<&str> = lines
            .iter()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty())
            .collect();
        let cols = rows.first().map_or(0, |l| l.chars().count());
        if cols == 0 {
            return Err("the map is empty".into());
        }
        if cols > 256 || rows.len() > 256 {
            return Err("the map is larger than 256 by 256 cells".into());
        }
        let mut grid = Grid::new(cols, rows.len());
        for (r, line) in rows.iter().enumerate() {
            if line.chars().count() != cols {
                return Err(format!("map row {} has a different length", r + 1));
            }
            for (c, ch) in line.chars().enumerate() {
                let i = grid.index(c, r);
                grid.cells[i] = match ch {
                    '#' => Cell::Road,
                    'H' => Cell::House,
                    '.' => Cell::Empty,
                    other => {
                        return Err(format!("unknown map character '{other}' in row {}", r + 1))
                    }
                };
            }
        }
        Ok(grid)
    }

    pub fn format(&self) -> String {
        let mut out = String::with_capacity((self.cols + 1) * self.rows);
        for r in 0..self.rows {
            for c in 0..self.cols {
                out.push(match self.cells[self.index(c, r)] {
                    Cell::Empty => '.',
                    Cell::Road => '#',
                    Cell::House => 'H',
                });
            }
            out.push('\n');
        }
        out
    }
}
