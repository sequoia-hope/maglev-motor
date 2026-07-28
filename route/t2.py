import pcbnew, sys
b = pcbnew.LoadBoard('amzhex.kicad_pcb')
# check outline
import pcbnew as p
outline = p.SHAPE_POLY_SET()
err = b.GetBoardPolygonOutlines(outline)
print("outline ok:", err, "polys:", outline.OutlineCount())
if outline.OutlineCount():
    print("pts:", outline.Outline(0).PointCount())
