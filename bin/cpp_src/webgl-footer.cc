
int main(int argc, char** argv) {
  Replay replay(trace_name, bin_name, steps, _countof(steps));

  if (!replay.LoadResources()) {
    return 1;
  }

  return replay.Run();
}
