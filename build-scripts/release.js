const { execSync } = require('child_process');
const readline = require('readline');
const path = require('path');

// Check if git directory is clean
try {
  const status = execSync('git status --porcelain').toString().trim();
  if (status) {
    console.error('❌ Error: Git working directory is not clean. Please commit or stash changes first.');
    process.exit(1);
  }
} catch (err) {
  console.error('❌ Error checking git status:', err.message);
  process.exit(1);
}

// Get current branch
let currentBranch = 'main';
try {
  currentBranch = execSync('git branch --show-current').toString().trim();
} catch (err) {
  console.warn('⚠️ Warning: Could not detect current git branch, defaulting to "main".');
}

// Function to run the release process
function runRelease(type) {
  try {
    // 1. Run lint, build, and test first to make sure everything passes
    console.log('🔄 Running lint, build, and tests...');
    execSync('npm run lint', { stdio: 'inherit' });
    execSync('npm run build', { stdio: 'inherit' });
    execSync('npm run test', { stdio: 'inherit' });

    if (type === 'current') {
      // Get current version from package.json
      const pkg = require(path.join(__dirname, '../package.json'));
      const currentVersion = pkg.version;
      const tagName = `v${currentVersion}`;

      // Check if tag already exists
      const tagExists = execSync(`git tag -l "${tagName}"`).toString().trim();
      if (tagExists) {
        console.error(`❌ Error: Tag ${tagName} already exists!`);
        process.exit(1);
      }

      // Create tag for current version
      console.log(`\n🔄 Creating tag ${tagName} for current version...`);
      execSync(`git tag -a ${tagName} -m "chore(release): ${tagName}"`, { stdio: 'inherit' });

      // Push tag to remote
      console.log(`\n🔄 Pushing tag ${tagName} to remote...`);
      execSync(`git push origin ${tagName}`, { stdio: 'inherit' });

      console.log(`\n✅ Tag ${tagName} successfully created and pushed!`);
    } else {
      // 2. Bump version
      console.log(`\n🔄 Bumping version (${type})...`);
      execSync(`npm version ${type} -m "chore(release): %s"`, { stdio: 'inherit' });

      // 3. Push to git
      console.log(`\n🔄 Pushing commits and tags to remote (branch: ${currentBranch})...`);
      execSync(`git push origin ${currentBranch} --follow-tags`, { stdio: 'inherit' });

      console.log('\n✅ Release successfully completed!');
    }
  } catch (err) {
    console.error('\n❌ Release failed:', err.message);
    process.exit(1);
  }
}

// Get type from command line argument
const arg = process.argv[2];
const allowedTypes = ['patch', 'minor', 'major', 'current'];

if (arg) {
  if (allowedTypes.includes(arg)) {
    runRelease(arg);
  } else {
    console.error(`❌ Invalid release type "${arg}". Allowed values: patch, minor, major, current`);
    process.exit(1);
  }
} else {
  // Interactive mode
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  // Load current version for display
  let currentVersion = 'unknown';
  try {
    const pkg = require(path.join(__dirname, '../package.json'));
    currentVersion = pkg.version;
  } catch (err) {
    // Ignore
  }

  console.log(`Current version: v${currentVersion}\n`);
  console.log('Select release type:');
  console.log('1) patch (e.g. 0.1.0 -> 0.1.1)');
  console.log('2) minor (e.g. 0.1.0 -> 0.2.0)');
  console.log('3) major (e.g. 0.1.0 -> 1.0.0)');
  console.log('4) current (keep current version and create tag)');

  rl.question('Enter choice (1, 2, 3, or 4): ', (answer) => {
    let type = '';
    if (answer === '1') type = 'patch';
    else if (answer === '2') type = 'minor';
    else if (answer === '3') type = 'major';
    else if (answer === '4') type = 'current';
    else {
      console.error('❌ Invalid choice.');
      rl.close();
      process.exit(1);
    }
    rl.close();
    runRelease(type);
  });
}
