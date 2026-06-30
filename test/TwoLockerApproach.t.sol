// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import "forge-std/Test.sol";
import "../src/MigrationRelease.sol";
import "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";

contract TwoLockerApproachTest is Test {
    MigrationRelease public implementation;
    TransparentUpgradeableProxy public proxy;
    MigrationRelease public release;
    ProxyAdmin public proxyAdmin;

    address public owner;
    address public alice;
    address public bob;

    uint256 public constant EPOCH = 1;
    uint256 public constant PRE_AMOUNT = 100 ether;
    uint256 public constant MAIN_AMOUNT = 50 ether;
    uint256 public constant COMBINED_AMOUNT = 150 ether;

    function setUp() public {
        owner = address(this);
        alice = makeAddr("alice");
        bob = makeAddr("bob");

        implementation = new MigrationRelease();
        proxyAdmin = new ProxyAdmin(owner);

        bytes memory initData = abi.encodeWithSelector(MigrationRelease.initialize.selector, owner);
        proxy = new TransparentUpgradeableProxy(address(implementation), address(proxyAdmin), initData);
        release = MigrationRelease(address(proxy));

        release.addFunds{ value: 10_000 ether }();
    }

    function _leaf(address user, uint256 amount, uint256 epoch) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(user, amount, epoch));
    }

    function _instantPayout(uint256 amount) internal view returns (uint256) {
        return (amount * release.INSTANT_RATIO()) / 10;
    }

    function _buildTwoLeafTree(bytes32 leafA, bytes32 leafB)
        internal
        pure
        returns (bytes32 root, bytes32[] memory proofA, bytes32[] memory proofB)
    {
        bool swapped = false;
        if (uint256(leafA) > uint256(leafB)) {
            (leafA, leafB) = (leafB, leafA);
            swapped = true;
        }

        root = keccak256(abi.encodePacked(leafA, leafB));

        proofA = new bytes32[](1);
        proofB = new bytes32[](1);

        if (!swapped) {
            proofA[0] = leafB;
            proofB[0] = leafA;
        } else {
            proofA[0] = leafA;
            proofB[0] = leafB;
        }
    }

    function _setRootAndGetAliceProof(uint256 aliceAmount, uint256 bobAmount) internal returns (bytes32[] memory aliceProof) {
        bytes32 aliceLeaf = _leaf(alice, aliceAmount, EPOCH);
        bytes32 bobLeaf = _leaf(bob, bobAmount, EPOCH);
        (bytes32 root, bytes32[] memory proof,) = _buildTwoLeafTree(aliceLeaf, bobLeaf);
        release.setMerkleRoot(root);
        return proof;
    }

    function testCombinedRootOnlyAllowsSingleFinalClaim() public {
        bytes32[] memory combinedProof = _setRootAndGetAliceProof(COMBINED_AMOUNT, 200 ether);

        vm.expectRevert("Not Whitelisted or already Claimed");
        release.releaseInstant(alice, PRE_AMOUNT, EPOCH, combinedProof);

        release.releaseInstant(alice, COMBINED_AMOUNT, EPOCH, combinedProof);

        assertEq(release.instantClaimTime(_leaf(alice, PRE_AMOUNT, EPOCH)), 0);
        assertGt(release.instantClaimTime(_leaf(alice, COMBINED_AMOUNT, EPOCH)), 0);
        assertEq(alice.balance, _instantPayout(COMBINED_AMOUNT));
    }

    function testClaimingPreRootThenPublishingCombinedRootEnablesSecondClaim() public {
        bytes32[] memory preProof = _setRootAndGetAliceProof(PRE_AMOUNT, 200 ether);
        release.releaseInstant(alice, PRE_AMOUNT, EPOCH, preProof);

        bytes32 combinedLeaf = _leaf(alice, COMBINED_AMOUNT, EPOCH);
        assertEq(release.instantClaimTime(combinedLeaf), 0);

        bytes32[] memory combinedProof = _setRootAndGetAliceProof(COMBINED_AMOUNT, 200 ether);
        release.releaseInstant(alice, COMBINED_AMOUNT, EPOCH, combinedProof);

        assertGt(release.instantClaimTime(_leaf(alice, PRE_AMOUNT, EPOCH)), 0);
        assertGt(release.instantClaimTime(combinedLeaf), 0);
        assertEq(alice.balance, _instantPayout(PRE_AMOUNT) + _instantPayout(COMBINED_AMOUNT));
    }

    function testRunningSeparateRootsDropsUnclaimedPreMigrationLeaf() public {
        bytes32[] memory preProof = _setRootAndGetAliceProof(PRE_AMOUNT, 200 ether);
        bytes32[] memory mainProof = _setRootAndGetAliceProof(MAIN_AMOUNT, 300 ether);

        vm.expectRevert("Not Whitelisted or already Claimed");
        release.releaseInstant(alice, PRE_AMOUNT, EPOCH, preProof);

        release.releaseInstant(alice, MAIN_AMOUNT, EPOCH, mainProof);
        assertEq(alice.balance, _instantPayout(MAIN_AMOUNT));
    }

    function testSeparateRootsWithSameAmountAndEpochCollideOnSameLeaf() public {
        bytes32[] memory preProof = _setRootAndGetAliceProof(MAIN_AMOUNT, 200 ether);
        release.releaseInstant(alice, MAIN_AMOUNT, EPOCH, preProof);

        bytes32 sharedLeaf = _leaf(alice, MAIN_AMOUNT, EPOCH);
        assertGt(release.instantClaimTime(sharedLeaf), 0);

        bytes32[] memory mainProof = _setRootAndGetAliceProof(MAIN_AMOUNT, 300 ether);

        vm.expectRevert("Not Whitelisted or already Claimed");
        release.releaseInstant(alice, MAIN_AMOUNT, EPOCH, mainProof);
    }
}
