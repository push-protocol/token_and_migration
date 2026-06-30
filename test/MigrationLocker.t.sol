// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import "forge-std/Test.sol";
import "./mocks/PushTokenMock.sol";
import "../src/MigrationLocker.sol";
import "../src/interfaces/IPush.sol";
import { IPushMock } from "./interfaces/v8/IPushMock.sol";
import "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";

contract MigrationLockerTest is Test {
    MigrationLocker public implementation;
    TransparentUpgradeableProxy public proxy;
    MigrationLocker public locker;
    ProxyAdmin public proxyAdmin;
    PushTokenMock public pushToken;

    address public owner;
    address public user1;
    address public user2;
    address public user3;
    address public otherToken;

    uint256 public constant INITIAL_BALANCE = 1000 ether;
    uint256 public constant LOCK_AMOUNT_1 = 100 ether;
    uint256 public constant LOCK_AMOUNT_2 = 200 ether;
    uint256 public constant LOCK_AMOUNT_3 = 300 ether;

    event Locked(address caller, address recipient, uint256 amount, uint256 epoch);
    event Unlocked(address indexed sender, address indexed recipient, uint256 amount, uint256 epoch);

    function setUp() public {
        owner = address(this);
        user1 = makeAddr("user1");
        user2 = makeAddr("user2");
        user3 = makeAddr("user3");
        otherToken = makeAddr("otherToken");

        pushToken = new PushTokenMock();
        pushToken.mint(user1, INITIAL_BALANCE);
        pushToken.mint(user2, INITIAL_BALANCE);
        pushToken.mint(user3, INITIAL_BALANCE);

        implementation = new MigrationLocker();
        proxyAdmin = new ProxyAdmin(owner);
        locker = _deployLocker(true);

        vm.mockCall(
            address(locker.PUSH_TOKEN()), abi.encodeWithSelector(IPushMock.transferFrom.selector), abi.encode(true)
        );
        vm.mockCall(address(locker.PUSH_TOKEN()), abi.encodeWithSelector(IPUSH.permit.selector), abi.encode());
        vm.mockCall(address(locker.PUSH_TOKEN()), abi.encodeWithSelector(IPushMock.burn.selector), abi.encode());
        vm.mockCall(
            address(locker.PUSH_TOKEN()), abi.encodeWithSelector(IPushMock.balanceOf.selector), abi.encode(1000 ether)
        );
        vm.mockCall(address(locker.PUSH_TOKEN()), abi.encodeWithSelector(IPushMock.transfer.selector), abi.encode(true));
    }

    function _deployLocker(bool refundsEnabled) internal returns (MigrationLocker deployedLocker) {
        bytes memory initData = abi.encodeWithSelector(MigrationLocker.initialize.selector, owner, refundsEnabled);
        proxy = new TransparentUpgradeableProxy(address(implementation), address(proxyAdmin), initData);
        deployedLocker = MigrationLocker(address(proxy));
    }

    function _lockFrom(address sender, address recipient, uint256 amount) internal {
        vm.prank(sender);
        locker.lock(amount, recipient);
    }

    /*//////////////////////////////////////////////////////////////
                             INITIALIZATION TESTS
    //////////////////////////////////////////////////////////////*/

    function testInitialization() public view {
        assertEq(locker.paused(), false);
        assertEq(locker.owner(), owner);
        assertEq(locker.epoch(), 1);
        assertEq(locker.refundsEnabled(), true);
    }

    function testInitializationCanDisableRefunds() public {
        MigrationLocker refundsDisabledLocker = _deployLocker(false);
        assertEq(refundsDisabledLocker.refundsEnabled(), false);
        assertEq(refundsDisabledLocker.epoch(), 1);
    }

    function testInitiateNewEpoch() public {
        uint256 initialEpoch = locker.epoch();

        vm.roll(block.number + 10);
        locker.initiateNewEpoch();

        assertEq(locker.epoch(), initialEpoch + 1);
        assertEq(locker.epochStartBlock(initialEpoch + 1), block.number);
    }

    function testOnlyOwnerCanInitiateNewEpoch() public {
        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(OwnableUnauthorizedAccount.selector, user1));
        locker.initiateNewEpoch();
    }

    function testCannotInitializeWithZeroAddress() public {
        MigrationLocker newImplementation = new MigrationLocker();
        ProxyAdmin newProxyAdmin = new ProxyAdmin(owner);
        bytes memory initData = abi.encodeWithSelector(MigrationLocker.initialize.selector, address(0), true);

        vm.expectRevert("Invalid owner");
        new TransparentUpgradeableProxy(address(newImplementation), address(newProxyAdmin), initData);
    }

    function testCannotReinitialize() public {
        vm.expectRevert(abi.encodeWithSelector(InvalidInitialization.selector));
        locker.initialize(address(this), true);
    }

    /*//////////////////////////////////////////////////////////////
                             TOGGLE LOCK TESTS
    //////////////////////////////////////////////////////////////*/

    function testToggleLock() public {
        assertEq(locker.paused(), false);

        locker.pause();
        assertEq(locker.paused(), true);

        locker.unpause();
        assertEq(locker.paused(), false);
    }

    function testOnlyOwnerCanToggleLock() public {
        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(OwnableUnauthorizedAccount.selector, user1));
        locker.pause();
    }

    /*//////////////////////////////////////////////////////////////
                                 LOCK TESTS
    //////////////////////////////////////////////////////////////*/

    function testLock() public {
        vm.expectEmit(true, true, true, true);
        emit Locked(user1, user2, LOCK_AMOUNT_1, locker.epoch());
        vm.prank(user1);
        locker.lock(LOCK_AMOUNT_1, user2);

        assertEq(locker.lockedBySenderRecipientEpoch(user1, user2, locker.epoch()), LOCK_AMOUNT_1);
    }

    function testLockWithPermitIncrementsTrackedBalance() public {
        uint256 deadline = block.timestamp + 1 days;

        vm.expectCall(
            address(locker.PUSH_TOKEN()),
            abi.encodeWithSelector(
                IPUSH.permit.selector,
                user1,
                address(locker),
                LOCK_AMOUNT_2,
                deadline,
                27,
                bytes32(uint256(1)),
                bytes32(uint256(2))
            )
        );
        vm.expectCall(
            address(locker.PUSH_TOKEN()),
            abi.encodeWithSelector(IPushMock.transferFrom.selector, user1, address(locker), LOCK_AMOUNT_2)
        );

        vm.prank(user1);
        locker.lockWithPermit(LOCK_AMOUNT_2, user2, deadline, 27, bytes32(uint256(1)), bytes32(uint256(2)));

        assertEq(locker.lockedBySenderRecipientEpoch(user1, user2, locker.epoch()), LOCK_AMOUNT_2);
    }

    function testCannotLockWhenPaused() public {
        locker.pause();

        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(EnforcedPause.selector));
        locker.lock(LOCK_AMOUNT_1, user1);
    }

    function testCannotLockToZeroAddress() public {
        vm.prank(user1);
        vm.expectRevert("Invalid recipient");
        locker.lock(LOCK_AMOUNT_1, address(0));
    }

    function testCannotLockToContract() public {
        vm.prank(user1);
        vm.expectRevert("Invalid recipient");
        locker.lock(LOCK_AMOUNT_1, address(locker));
    }

    /*//////////////////////////////////////////////////////////////
                                REFUND TESTS
    //////////////////////////////////////////////////////////////*/

    function testRefundLockedFundsReturnsToOriginalSender() public {
        _lockFrom(user1, user2, LOCK_AMOUNT_1);

        vm.expectEmit(true, true, true, true);
        emit Unlocked(user1, user2, 40 ether, locker.epoch());
        vm.expectCall(address(locker.PUSH_TOKEN()), abi.encodeWithSelector(IPushMock.transfer.selector, user1, 40 ether));

        locker.refundLockedFunds(user1, user2, 40 ether, locker.epoch());

        assertEq(locker.lockedBySenderRecipientEpoch(user1, user2, locker.epoch()), 60 ether);
    }

    function testRefundReducesOnlyRequestedSenderRecipientEpochBucket() public {
        _lockFrom(user1, user2, LOCK_AMOUNT_1);
        _lockFrom(user1, user3, LOCK_AMOUNT_2);
        _lockFrom(user2, user2, LOCK_AMOUNT_3);

        locker.initiateNewEpoch();
        _lockFrom(user1, user2, 25 ether);

        locker.refundLockedFunds(user1, user2, 30 ether, 1);

        assertEq(locker.lockedBySenderRecipientEpoch(user1, user2, 1), 70 ether);
        assertEq(locker.lockedBySenderRecipientEpoch(user1, user3, 1), LOCK_AMOUNT_2);
        assertEq(locker.lockedBySenderRecipientEpoch(user2, user2, 1), LOCK_AMOUNT_3);
        assertEq(locker.lockedBySenderRecipientEpoch(user1, user2, 2), 25 ether);
    }

    function testPartialRefundPreservesRemainingBalance() public {
        _lockFrom(user1, user2, LOCK_AMOUNT_1);

        locker.refundLockedFunds(user1, user2, 10 ether, locker.epoch());
        locker.refundLockedFunds(user1, user2, 15 ether, locker.epoch());

        assertEq(locker.lockedBySenderRecipientEpoch(user1, user2, locker.epoch()), 75 ether);
    }

    function testCannotRefundMoreThanTrackedBalance() public {
        _lockFrom(user1, user2, LOCK_AMOUNT_1);
        uint256 currentEpoch = locker.epoch();

        vm.expectRevert("Insufficient locked balance");
        locker.refundLockedFunds(user1, user2, LOCK_AMOUNT_1 + 1, currentEpoch);
    }

    function testCannotRefundWhenRefundsDisabled() public {
        MigrationLocker refundsDisabledLocker = _deployLocker(false);
        uint256 currentEpoch = refundsDisabledLocker.epoch();

        vm.mockCall(
            address(refundsDisabledLocker.PUSH_TOKEN()),
            abi.encodeWithSelector(IPushMock.transferFrom.selector),
            abi.encode(true)
        );

        vm.prank(user1);
        refundsDisabledLocker.lock(LOCK_AMOUNT_1, user2);

        vm.expectRevert("Refunds disabled");
        refundsDisabledLocker.refundLockedFunds(user1, user2, 1 ether, currentEpoch);
    }

    function testOnlyOwnerCanRefundLockedFunds() public {
        _lockFrom(user1, user2, LOCK_AMOUNT_1);
        uint256 currentEpoch = locker.epoch();

        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(OwnableUnauthorizedAccount.selector, user1));
        locker.refundLockedFunds(user1, user2, 1 ether, currentEpoch);
    }

    function testCannotRefundWhenPaused() public {
        _lockFrom(user1, user2, LOCK_AMOUNT_1);
        locker.pause();
        uint256 currentEpoch = locker.epoch();

        vm.expectRevert(abi.encodeWithSelector(EnforcedPause.selector));
        locker.refundLockedFunds(user1, user2, 1 ether, currentEpoch);
    }

    /*//////////////////////////////////////////////////////////////
                                 BURN TESTS
    //////////////////////////////////////////////////////////////*/

    function testBurn() public {
        uint256 burnAmount = 100 ether;

        vm.expectCall(address(locker.PUSH_TOKEN()), abi.encodeWithSelector(IPushMock.burn.selector, burnAmount));
        locker.burn(burnAmount);
    }

    function testOnlyOwnerCanBurn() public {
        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(OwnableUnauthorizedAccount.selector, user1));
        locker.burn(100 ether);
    }

    function testCannotBurnWhenPaused() public {
        locker.pause();

        vm.expectRevert(abi.encodeWithSelector(EnforcedPause.selector));
        locker.burn(100 ether);
    }

    /*//////////////////////////////////////////////////////////////
                          RECOVER FUNDS TESTS
    //////////////////////////////////////////////////////////////*/

    function testCannotRecoverPushFunds() public {
        address pushTokenAddress = locker.PUSH_TOKEN();

        vm.expectRevert("PUSH recovery disabled");
        locker.recoverFunds(pushTokenAddress, user1, 100 ether);
    }

    function testRecoverNonPushFunds() public {
        uint256 recoverAmount = 100 ether;

        vm.mockCall(otherToken, abi.encodeWithSelector(IPushMock.balanceOf.selector, address(locker)), abi.encode(1000 ether));
        vm.mockCall(otherToken, abi.encodeWithSelector(IPushMock.transfer.selector), abi.encode(true));

        vm.expectCall(otherToken, abi.encodeWithSelector(IPushMock.transfer.selector, user1, recoverAmount));
        locker.recoverFunds(otherToken, user1, recoverAmount);
    }

    function testOnlyOwnerCanRecoverFunds() public {
        vm.mockCall(otherToken, abi.encodeWithSelector(IPushMock.balanceOf.selector, address(locker)), abi.encode(1000 ether));

        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(OwnableUnauthorizedAccount.selector, user1));
        locker.recoverFunds(otherToken, user2, 100 ether);
    }

    function testCannotRecoverWhenPaused() public {
        locker.pause();
        vm.mockCall(otherToken, abi.encodeWithSelector(IPushMock.balanceOf.selector, address(locker)), abi.encode(1000 ether));

        vm.expectRevert(abi.encodeWithSelector(EnforcedPause.selector));
        locker.recoverFunds(otherToken, user1, 100 ether);
    }

    function testCannotRecoverToZeroAddress() public {
        vm.mockCall(otherToken, abi.encodeWithSelector(IPushMock.balanceOf.selector, address(locker)), abi.encode(1000 ether));

        vm.expectRevert("Invalid recipient");
        locker.recoverFunds(otherToken, address(0), 100 ether);
    }

    function testCannotRecoverZeroAmount() public {
        vm.mockCall(otherToken, abi.encodeWithSelector(IPushMock.balanceOf.selector, address(locker)), abi.encode(1000 ether));

        vm.expectRevert("Invalid amount");
        locker.recoverFunds(otherToken, user1, 0);
    }

    function testCannotRecoverMoreThanBalance() public {
        vm.mockCall(otherToken, abi.encodeWithSelector(IPushMock.balanceOf.selector, address(locker)), abi.encode(500 ether));

        vm.expectRevert("Invalid amount");
        locker.recoverFunds(otherToken, user1, 1000 ether);
    }

    /*//////////////////////////////////////////////////////////////
                         ACTUAL TOKEN TRANSFER TESTS
    //////////////////////////////////////////////////////////////*/

    function testActualTokenTransfer() public {
        PushTokenMock newToken = new PushTokenMock();
        address testUser = makeAddr("testUser");
        newToken.mint(testUser, 1000 ether);

        MockMigrationLocker customLocker = new MockMigrationLocker(address(newToken));

        uint256 initialUserBalance = newToken.balanceOf(testUser);
        uint256 initialLockerBalance = newToken.balanceOf(address(customLocker));

        vm.prank(testUser);
        newToken.approve(address(customLocker), 100 ether);

        vm.prank(testUser);
        customLocker.lock(100 ether, testUser);

        uint256 finalUserBalance = newToken.balanceOf(testUser);
        uint256 finalLockerBalance = newToken.balanceOf(address(customLocker));

        assertEq(finalUserBalance, initialUserBalance - 100 ether);
        assertEq(finalLockerBalance, initialLockerBalance + 100 ether);
    }
}

contract MockMigrationLocker is Initializable, Ownable2StepUpgradeable, PausableUpgradeable {
    event Locked(address caller, address recipient, uint256 amount, uint256 epoch);

    uint256 public epoch = 1;
    address public immutable PUSH_TOKEN;

    constructor(address tokenAddress) {
        PUSH_TOKEN = tokenAddress;
        _disableInitializers();
    }

    function initialize(address initialOwner) public initializer {
        require(initialOwner != address(0), "Invalid owner");
        __Ownable2Step_init();
        __Ownable_init(initialOwner);
        __Pausable_init();
    }

    function lock(uint256 _amount, address _recipient) external {
        uint256 codeLength;
        assembly {
            codeLength := extcodesize(_recipient)
        }
        if (_recipient == address(0) || codeLength > 0) {
            revert("Invalid recipient");
        }

        IPUSH(PUSH_TOKEN).transferFrom(msg.sender, address(this), _amount);
        emit Locked(msg.sender, _recipient, _amount, epoch);
    }
}

error OwnableUnauthorizedAccount(address account);
error InvalidInitialization();
error EnforcedPause();
