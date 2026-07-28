import sys, pcbnew, time
inp, outp = sys.argv[1], sys.argv[2]
t=time.time(); b = pcbnew.LoadBoard(inp); print("load %.1fs"%(time.time()-t), flush=True)
print("tracks", len(b.GetTracks()), "footprints", len(b.GetFootprints()), "nets", b.GetNetCount(), flush=True)
t=time.time(); ok = pcbnew.ExportSpecctraDSN(b, outp); print("dsn %.1fs ok=%s"%(time.time()-t, ok), flush=True)
