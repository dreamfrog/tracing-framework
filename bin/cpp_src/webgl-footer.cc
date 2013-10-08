
int main(int argc, char** argv) {
  Replay replay(trace_name, steps, _countof(steps));

  replay.LoadResources();
  return replay.Run();
}
