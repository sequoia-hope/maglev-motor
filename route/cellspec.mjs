// The periodic cell's seam interface: cell-frame (y-up, coil centre origin)
// offsets of the seam vias on a cell's EAST seam, one per bus signal. Shared
// by cellgen.mjs / quadgen.mjs (which place them as real vias) and the
// routing-problem builders (which hand a block's own set to the router as
// anchors). See cellgen.mjs for the derivation of the positions.
//
// LADDER v2 (2026-07-29): the two staggered columns INTERLEAVE with a 0.42 mm
// vertical gap between any via and the other column's nearest via. That makes
// every constructed lane a dead-straight horizontal run on the inner
// electronics layer: a run at its own via's offset passes every other via of
// its own column at >= 0.84 (pass-through at its own), and every via of the
// other column at >= 0.42 -- which clears the 0.39 mm a 0.1 mm trace needs
// from a 0.5 mm via barrel (0.25 + 0.09 + 0.05) with 0.03 to spare. No jogs,
// and no lane ever crosses another. v1 (VBUS .80 / GND 1.40 / VLOGIC 1.10 /
// SDA 1.70 / SCL 2.00 / DATA -.70 / SCLK -1.30 / RCLK -.45 / OE_N -2.05) had
// 0.25-0.30 cross-column gaps: five of nine signals could not thread a seam
// without weaving, and SDA/VLOGIC were trapped both sides.
//
// Assignment principle (unchanged): register signals anchor SOUTH of the
// corridor next to the register; power and the reserved I2C pair anchor
// NORTH near the bridge and decap. Power (router-routed, not constructed)
// sits between the SDA and SCL runs, whose keepouts leave a 1.4 mm approach
// band on the inner layer.
// Pairwise via spacing: same column 0.84, cross column hypot(0.57, 0.42)
// = 0.71 -- both over the 0.59 floor.
// v3: every CONSTRUCTED lane sits at |offset| >= 1.26 -- the centre via BAY
// (six crossover vias on a 0.679 ring at every coil centre) spans offsets up
// to +/-0.68, and a straight run crosses every cell centre on its row, so
// lanes inside |1.07| are impossible. Power (VBUS/GND, router-routed, never
// constructed) takes the two inner slots. quadgen bans gutter vias from the
// lane bands (viaPlan banBands, |y| in [0.85, 2.93]) so the run lines stay
// clear across the whole row.
// v4 (2026-07-31): both columns shifted 0.12 mm WEST (A 3.95 -> 3.83,
// B 4.52 -> 4.40). The gutter is 1.590 wide and the v3 ladder split it so
// evenly that NO winding-layer lane could pass the ladder span (a 0.1 mm
// trace needs 0.53 mm between a via column and a hex, and both sides had
// 0.51). The shift keeps every existing clearance -- A stays 0.052 clear of
// the west hex's via rule, y offsets and the interleave are untouched -- and
// opens a 0.628 mm corridor EAST of column B: the fabric's N-S hug lane at
// cell + 4.795 (0.395 from B's barrels, 0.094 clear of the east hex rule),
// one independent copy per winding layer.
export const SEAM_SIGNALS = [
  { net: 'VBUS', at: [3.83, -0.42] },
  { net: 'GND', at: [4.40, 0.42] },
  { net: 'VLOGIC', at: [4.40, 1.68] },
  { net: 'SDA', at: [3.83, 1.26] },     // reserved: sensor-variant cells
  { net: 'SCL', at: [3.83, 2.10] },     // reserved
  { net: 'DATA', at: [3.83, -2.10] },   // net DATA_{k+1}: out of cell k, into k+1
  { net: 'SCLK', at: [3.83, -1.26] },
  { net: 'RCLK', at: [4.40, -1.68] },
  { net: 'OE_N', at: [4.40, -2.52] },
];
// The fabric hug lane's offset from the WEST cell's centre (see above).
export const FABRIC_HUG_X = 4.795;
