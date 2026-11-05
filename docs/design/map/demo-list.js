// SAMPLE DATA for the Kendall basemap preview only (MEM-077): not real study data. Placing a list on a route
// (slice B7, MEM-052) is not built yet, so the station detail shows this made-up list. Shape follows the
// product brief: one study list on the route, one item per station, each with the 8 association channels
// (docs/plans/2026-10-31-map-to-palace.md), records as in static/app.js AssocEntry. Station 6 holds nothing,
// so the preview also shows the empty case. Keys are station numbers (preview stations have no ids).
window.mpDemoList = {
  name: "Biology ch. 3: parts of a cell",
  items: {
    1: {
      item: "Nucleus: holds the cell's DNA and directs it",
      record: {
        kinesthetic: "You grip the handrail at the centre of the platform, the rail the whole crowd steers by.",
        auditory: "The announcer reads out the day's instructions, the DNA read aloud.",
        visual: "A glowing round control booth in the middle of the platform.",
        emotional: "The calm of knowing someone is in charge.",
        conceptual: "Every trip starts from this hub; every cell job starts from the nucleus.",
        olfactory: "Old paper blueprints in the booth.",
        gustatory: "A plain cracker, the basic recipe.",
        spatial: "Centre of the platform, under the exit stairs."
      }
    },
    2: {
      item: "Mitochondria: make the cell's energy (ATP)",
      record: {
        kinesthetic: "You push the revolving door and it spins up like a turbine.",
        auditory: "A steady generator hum from the base of the tower.",
        visual: "The tower lights up floor by floor like a battery charging.",
        emotional: "A jolt of get-up-and-go.",
        conceptual: "The tower that looks like a power plant is the powerhouse of the cell.",
        olfactory: "Fresh coffee from the market at its base.",
        gustatory: "A sugary energy drink.",
        spatial: "At the tower's foot, where Third St begins."
      }
    },
    3: {
      item: "Ribosomes: build proteins",
      record: {
        kinesthetic: "You snap small bricks together on a ledge between the towers.",
        auditory: "Steady clicking, one brick per beat.",
        visual: "Two towers stacked from small identical blocks.",
        emotional: "The satisfaction of building something piece by piece.",
        conceptual: "The twin towers are the two ribosome subunits assembling a chain.",
        olfactory: "Warm plastic.",
        gustatory: "A string of candy beads, bead after bead.",
        spatial: "Both sides of Third St at Kendall St."
      }
    },
    4: {
      item: "Endoplasmic reticulum: folds and ships proteins",
      record: {
        kinesthetic: "You walk a folded maze of hallways, turning at every door.",
        auditory: "Parcels sliding down chutes.",
        visual: "Corridors stacked like folded ribbon, studded with doorbells.",
        emotional: "Busy, orderly bustle.",
        conceptual: "A network of folded passages is the ER's folded membrane.",
        olfactory: "Fresh cardboard boxes.",
        gustatory: "A folded crepe.",
        spatial: "On Third St, past the twin towers."
      }
    },
    5: {
      item: "Golgi apparatus: packages and labels proteins",
      record: {
        kinesthetic: "You tape and stamp a parcel in the old boiler works.",
        auditory: "A label printer chattering.",
        visual: "Brick floors stacked flat like pancakes, each with a shipping label.",
        emotional: "The relief of a job wrapped up.",
        conceptual: "The last stop on Third St is the last stop before export.",
        olfactory: "Packing tape and brick dust.",
        gustatory: "A stack of pancakes.",
        spatial: "Corner of Third St and Binney St."
      }
    }
  }
};
